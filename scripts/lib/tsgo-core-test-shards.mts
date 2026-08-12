export const TSGO_CORE_TEST_MAX_ROOTS = 720;

export const TSGO_CORE_TEST_SHARDS = [
  { name: "agents-root", config: "test/tsconfig/tsconfig.core.test.agents-root.json" },
  { name: "agents-other", config: "test/tsconfig/tsconfig.core.test.agents-other.json" },
  { name: "gateway", config: "test/tsconfig/tsconfig.core.test.gateway.json" },
  { name: "infra", config: "test/tsconfig/tsconfig.core.test.infra.json" },
  { name: "commands", config: "test/tsconfig/tsconfig.core.test.commands.json" },
  {
    name: "plugins-platform",
    config: "test/tsconfig/tsconfig.core.test.plugins-platform.json",
  },
  { name: "config-cli", config: "test/tsconfig/tsconfig.core.test.config-cli.json" },
  { name: "messaging", config: "test/tsconfig/tsconfig.core.test.messaging.json" },
  { name: "services", config: "test/tsconfig/tsconfig.core.test.services.json" },
  { name: "other", config: "test/tsconfig/tsconfig.core.test.other.json" },
  {
    name: "ui-pages-e2e",
    config: "test/tsconfig/tsconfig.core.test.ui-pages-e2e.json",
  },
  { name: "ui-other", config: "test/tsconfig/tsconfig.core.test.ui-other.json" },
  { name: "packages", config: "test/tsconfig/tsconfig.test.packages.json" },
] as const;

export type TsgoCoreTestShard = (typeof TSGO_CORE_TEST_SHARDS)[number];

export function findTsgoCoreTestShardViolations(params: {
  canonicalRoots: readonly string[];
  maxRoots?: number;
  shards: readonly { name: string; roots: readonly string[] }[];
}): string[] {
  const maxRoots = params.maxRoots ?? TSGO_CORE_TEST_MAX_ROOTS;
  const canonical = new Set(params.canonicalRoots);
  const owners = new Map<string, string[]>();
  const violations: string[] = [];

  for (const shard of params.shards) {
    if (shard.roots.length > maxRoots) {
      violations.push(
        `${shard.name}: ${shard.roots.length} test roots exceeds the ${maxRoots} limit`,
      );
    }
    for (const root of shard.roots) {
      const rootOwners = owners.get(root) ?? [];
      rootOwners.push(shard.name);
      owners.set(root, rootOwners);
    }
  }

  for (const root of canonical) {
    const rootOwners = owners.get(root) ?? [];
    if (rootOwners.length === 0) {
      violations.push(`unassigned: ${root}`);
    } else if (rootOwners.length > 1) {
      violations.push(`assigned ${rootOwners.length} times (${rootOwners.join(", ")}): ${root}`);
    }
  }
  for (const [root, rootOwners] of owners) {
    if (!canonical.has(root)) {
      violations.push(`not in the canonical core-test graph (${rootOwners.join(", ")}): ${root}`);
    }
  }

  return violations;
}
