import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";

export function projectPublicProviderCatalogOutcomes(
  outcomes: readonly ProviderCatalogOutcome[] | undefined,
): ProviderCatalogOutcome[] | undefined {
  return outcomes?.map(({ provider, profileId, status }) => ({
    provider,
    ...(profileId ? { profileId } : {}),
    status,
  }));
}

export function applyProviderCatalogOutcomesToModelAuth(params: {
  provider: string;
  modelId: string;
  outcomes?: readonly ProviderCatalogOutcome[];
  resolved: ModelAuthAvailabilityEvaluation;
  evaluateForProfile: (profileId: string) => ModelAuthAvailabilityEvaluation;
}): ModelAuthAvailabilityEvaluation {
  const provider = normalizeProviderId(params.provider);
  const outcomes =
    params.outcomes?.filter((outcome) => normalizeProviderId(outcome.provider) === provider) ?? [];
  const modelId = params.modelId.trim().toLowerCase();
  const authorizingProfileIds = outcomes.flatMap((outcome) =>
    outcome.status === "ready" &&
    outcome.profileId &&
    outcome.modelIds?.some((candidate) => candidate.trim().toLowerCase() === modelId)
      ? [outcome.profileId]
      : [],
  );
  if (
    authorizingProfileIds.length > 0 &&
    !authorizingProfileIds.includes(params.resolved.selectedProfileId ?? "")
  ) {
    for (const profileId of authorizingProfileIds) {
      const candidate = params.evaluateForProfile(profileId);
      if (candidate.availability === true) {
        return candidate;
      }
    }
    return { ...params.resolved, availability: false };
  }
  // Stored credentials prove presence, not acceptance. Apply rejection only to
  // the profile discovery tested, or another valid profile would be hidden.
  return outcomes.some(
    (outcome) =>
      outcome.status === "auth-rejected" &&
      (outcome.profileId === undefined || outcome.profileId === params.resolved.selectedProfileId),
  )
    ? { ...params.resolved, availability: false }
    : params.resolved;
}
