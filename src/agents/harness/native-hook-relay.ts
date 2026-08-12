/** Public Plugin SDK facade for native harness hook relays. */
import {
  hasNativeHookRelayInvocationFromRegistry,
  invokeNativeHookRelayFromRegistry,
  nativeHookRelayTestingImplementation,
  registerNativeHookRelayForPublicFacade,
} from "./native-hook-relay-implementation.js";
import type { NativeHookRelayDeferredToolApprovalRequester } from "./native-hook-relay-permissions.js";
import type {
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayProcessResponse,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";

export { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
export { resolveNativeHookRelayDeferredToolApproval } from "./native-hook-relay-permissions.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  return registerNativeHookRelayForPublicFacade(params);
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  return await invokeNativeHookRelayFromRegistry(params);
}

export function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean {
  return hasNativeHookRelayInvocationFromRegistry(params);
}

export const testing = {
  clearNativeHookRelaysForTests(): void {
    nativeHookRelayTestingImplementation.clearNativeHookRelaysForTests();
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return nativeHookRelayTestingImplementation.getNativeHookRelayInvocationsForTests();
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return nativeHookRelayTestingImplementation.getNativeHookRelayRegistrationForTests(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    return nativeHookRelayTestingImplementation.getNativeHookRelayBridgeDirForTests();
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    return nativeHookRelayTestingImplementation.getNativeHookRelayBridgeRegistryPathForTests(
      relayId,
    );
  },
  getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
    return nativeHookRelayTestingImplementation.getNativeHookRelayBridgeRecordForTests(relayId);
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return nativeHookRelayTestingImplementation.isNativeHookRelayBridgeLookupRetryableForTests(
      error,
      elapsedMs,
    );
  },
  formatPermissionApprovalDescriptionForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return nativeHookRelayTestingImplementation.formatPermissionApprovalDescriptionForTests(
      request,
    );
  },
  permissionRequestContentFingerprintForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return nativeHookRelayTestingImplementation.permissionRequestContentFingerprintForTests(
      request,
    );
  },
  permissionRequestToolInputKeyFingerprintForTests(toolInput: Record<string, unknown>): string {
    return nativeHookRelayTestingImplementation.permissionRequestToolInputKeyFingerprintForTests(
      toolInput,
    );
  },
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    nativeHookRelayTestingImplementation.setNativeHookRelayPermissionApprovalRequesterForTests(
      requester,
    );
  },
  setNativeHookRelayDeferredToolApprovalRequesterForTests(
    requester: NativeHookRelayDeferredToolApprovalRequester,
  ): void {
    nativeHookRelayTestingImplementation.setNativeHookRelayDeferredToolApprovalRequesterForTests(
      requester,
    );
  },
} as const;
