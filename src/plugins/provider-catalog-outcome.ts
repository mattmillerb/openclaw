export type ProviderCatalogOutcome = {
  provider: string;
  /** Auth profile tested by discovery; omission means provider-wide auth. */
  profileId?: string;
  status: "ready" | "auth-rejected" | "unavailable";
  /** Models the tested profile's authoritative catalog allowed in this generation. */
  modelIds?: readonly string[];
};
