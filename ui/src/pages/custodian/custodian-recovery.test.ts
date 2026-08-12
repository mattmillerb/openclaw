/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCustodianRecoveryForScope,
  readCustodianRecoveryForClient,
  reconcileCustodianRecoveryForScope,
} from "./custodian-recovery.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
const recoveryScope = "principal-a";
const recoveryOwner = { gatewayUrl, recoveryScope };
const client = { recoveryScope, recoveryScopeReady: true } as never;

function remember(sessionId: string): void {
  reconcileCustodianRecoveryForScope(
    recoveryOwner,
    {
      sessionId,
      reply: "Enter a secret",
      action: "none",
      wizardInputPending: true,
      step: { id: "secret", type: "text", message: "Secret", sensitive: true },
    },
    sessionId,
  );
}

describe("Custodian wizard reload recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("stores only the active session handle in tab-scoped storage", () => {
    remember("custodian-live");
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).toBe("custodian-live");
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index))).toEqual([
      `openclaw.custodian.recovery.v1:${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}`,
    ]);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe("custodian-live");
  });

  it("rejects malformed state and clears only the expected session", () => {
    sessionStorage.setItem(
      `openclaw.custodian.recovery.v1:${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}`,
      "   ",
    );
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).toBeNull();
    expect(sessionStorage.length).toBe(0);

    remember("custodian-live");
    clearCustodianRecoveryForScope(recoveryOwner, "different-session");
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).not.toBeNull();
    clearCustodianRecoveryForScope(recoveryOwner, "custodian-live");
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).toBeNull();
  });

  it("keeps colliding unframed gateway and scope tuples independent", () => {
    const first = { gatewayUrl: "ws://gateway.test:18789", recoveryScope: "principal-a" };
    const second = { gatewayUrl: "ws://gateway.test", recoveryScope: "18789:principal-a" };
    const result = {
      reply: "Enter a secret",
      action: "none" as const,
      wizardInputPending: true,
      step: { id: "secret", type: "text" as const, message: "Secret", sensitive: true },
    };

    reconcileCustodianRecoveryForScope(first, { ...result, sessionId: "first" }, "first");
    reconcileCustodianRecoveryForScope(second, { ...result, sessionId: "second" }, "second");

    expect(
      readCustodianRecoveryForClient(
        { recoveryScope: first.recoveryScope, recoveryScopeReady: true } as never,
        first.gatewayUrl,
      ),
    ).toBe("first");
    expect(
      readCustodianRecoveryForClient(
        { recoveryScope: second.recoveryScope, recoveryScopeReady: true } as never,
        second.gatewayUrl,
      ),
    ).toBe("second");

    clearCustodianRecoveryForScope(first, "first");
    expect(
      readCustodianRecoveryForClient(
        { recoveryScope: second.recoveryScope, recoveryScopeReady: true } as never,
        second.gatewayUrl,
      ),
    ).toBe("second");
  });

  it("degrades cleanly when session storage access is denied", () => {
    const getItem = vi.fn(() => {
      throw new Error("storage denied");
    });
    const removeItem = vi.fn(() => {
      throw new Error("storage denied");
    });
    vi.stubGlobal("sessionStorage", { getItem, removeItem });

    expect(() => readCustodianRecoveryForClient(client, gatewayUrl)).not.toThrow();
    expect(getItem).toHaveBeenCalledOnce();
  });
});
