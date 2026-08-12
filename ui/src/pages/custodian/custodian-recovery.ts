import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

const STORAGE_PREFIX = "openclaw.custodian.recovery.v1:";

export type CustodianRecoveryScope = {
  gatewayUrl: string;
  recoveryScope: string;
};

// Web Storage keys are JS strings, so frame UTF-16 code units directly.
// This keeps variable gateway and identity components unambiguous.
function frameStorageKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

function storageKey(scope: CustodianRecoveryScope): string {
  return `${STORAGE_PREFIX}${frameStorageKeyPart(scope.gatewayUrl)}:${frameStorageKeyPart(scope.recoveryScope)}`;
}

export function captureCustodianRecoveryScope(
  client: GatewayBrowserClient,
  gatewayUrl: string,
): CustodianRecoveryScope | null {
  const normalizedGatewayUrl = gatewayUrl.trim();
  const recoveryScope = client.recoveryScopeReady ? (client.recoveryScope?.trim() ?? "") : "";
  return normalizedGatewayUrl && recoveryScope
    ? { gatewayUrl: normalizedGatewayUrl, recoveryScope }
    : null;
}

export function readCustodianRecoveryForClient(
  client: GatewayBrowserClient,
  gatewayUrl: string,
): string | null {
  const scope = captureCustodianRecoveryScope(client, gatewayUrl);
  return scope ? readCustodianRecovery(scope) : null;
}

export function reconcileCustodianRecoveryForScope(
  scope: CustodianRecoveryScope,
  result: SystemAgentChatResult,
  requestSessionId: string,
): void {
  if (result.wizardInputPending === true && result.step) {
    writeCustodianRecovery(scope, result.sessionId);
    return;
  }
  clearCustodianRecoveryForScope(scope, requestSessionId);
}

function readCustodianRecovery(scope: CustodianRecoveryScope): string | null {
  const key = storageKey(scope);
  try {
    const sessionId = globalThis.sessionStorage?.getItem(key);
    if (sessionId === null || sessionId === undefined) {
      return null;
    }
    if (!sessionId.trim()) {
      globalThis.sessionStorage?.removeItem(key);
      return null;
    }
    return sessionId;
  } catch {
    // Storage access can be denied entirely, including cleanup attempts.
    return null;
  }
}

function writeCustodianRecovery(scope: CustodianRecoveryScope, sessionId: string): void {
  if (!sessionId.trim()) {
    return;
  }
  try {
    globalThis.sessionStorage?.setItem(storageKey(scope), sessionId);
  } catch {
    // Recovery state is best-effort when browser storage is unavailable.
  }
}

export function clearCustodianRecoveryForScope(
  scope: CustodianRecoveryScope,
  expectedSessionId?: string,
): void {
  try {
    const storage = globalThis.sessionStorage;
    const key = storageKey(scope);
    if (expectedSessionId) {
      if (storage?.getItem(key) !== expectedSessionId) {
        return;
      }
    }
    storage?.removeItem(key);
  } catch {
    // Recovery state is best-effort to remove after a wizard leaves its active step.
  }
}
