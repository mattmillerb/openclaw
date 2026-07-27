import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

export async function readTargetToolIdentity(params: {
  env: QaSuiteRuntimeEnv;
  sessionKey: string;
  targetTool: string;
}) {
  const payload = (await params.env.gateway.call(
    "tools.effective",
    { sessionKey: params.sessionKey },
    { timeoutMs: liveTurnTimeoutMs(params.env, 90_000) },
  )) as {
    groups?: Array<{
      tools?: Array<{ id?: string; source?: string; pluginId?: string }>;
    }>;
  };
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id === params.targetTool) {
        return {
          source: tool.source?.trim() ?? "",
          pluginId: tool.pluginId?.trim() ?? "",
        };
      }
    }
  }
  throw new Error(`tools.effective did not report ${params.targetTool}`);
}
