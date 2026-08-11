// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

export async function loadModels(
  client: GatewayBrowserClient,
  opts?: {
    agentId?: string;
    refresh?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const cacheKey = opts?.agentId?.trim() ?? "";
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (!opts?.refresh && cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (!opts?.refresh && cached?.inFlight) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(client, {
    ...(cacheKey ? { agentId: cacheKey } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  })
    .then((models) => {
      const latest = cache.get(cacheKey);
      if (!latest || latest.inFlight === inFlight) {
        cache.set(cacheKey, {
          expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
          models,
        });
      }
      return models;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
  });
  return inFlight;
}

export function applyModelCatalogResult(models: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(models)) {
    return null;
  }
  return models as ModelCatalogEntry[];
}

async function requestModels(
  client: GatewayBrowserClient,
  opts: { agentId?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ModelCatalogEntry[]> {
  const requestOptions =
    opts.signal || opts.timeoutMs
      ? {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        }
      : undefined;
  const params = {
    view: "configured" as const,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };
  const result = requestOptions
    ? await client.request<{ models: ModelCatalogEntry[] }>("models.list", params, requestOptions)
    : await client.request<{ models: ModelCatalogEntry[] }>("models.list", params);
  return result?.models ?? [];
}
