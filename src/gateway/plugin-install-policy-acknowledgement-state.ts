import type { InstallPolicyWarningOccurrence } from "../plugins/install-security-scan.types.js";
import type { ManagedPluginSourceInstallRequest } from "../plugins/management-service.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type InstallPolicyAcknowledgement = {
  expiresAt: number;
  generation: number;
  requestKey: string;
  resolvedRequest: ManagedPluginSourceInstallRequest;
  warnings: InstallPolicyWarningOccurrence[];
};

type InstallPolicyAcknowledgementState = {
  generation: number;
  records: Map<string, InstallPolicyAcknowledgement>;
};

function revokeState(state: InstallPolicyAcknowledgementState): void {
  state.generation += 1;
  state.records.clear();
}

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.installPolicyAcknowledgements"),
  (): InstallPolicyAcknowledgementState => ({ generation: 0, records: new Map() }),
  revokeState,
  "close-and-restart",
);

export function getInstallPolicyAcknowledgementState(): InstallPolicyAcknowledgementState {
  return state;
}

/** Retires every approval before Gateway teardown can publish old-generation work. */
export function revokeInstallPolicyAcknowledgements(): void {
  revokeState(state);
}
