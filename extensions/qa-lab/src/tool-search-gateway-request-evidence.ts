import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function summarizeToolSearchProviderRequests(requests: unknown, targetTool: string) {
  if (!Array.isArray(requests)) {
    return [];
  }
  return requests.map((request) => {
    const record = isRecord(request) ? request : {};
    const body = isRecord(record.body) ? record.body : {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const declaredNames = new Set(
      tools.flatMap((tool) => {
        if (!isRecord(tool)) {
          return [];
        }
        const fn = isRecord(tool.function) ? tool.function : {};
        const name = fn.name ?? tool.name;
        return typeof name === "string" ? [name] : [];
      }),
    );
    return {
      plannedToolName: typeof record.plannedToolName === "string" ? record.plannedToolName : null,
      declaredToolCount: tools.length,
      targetDeclared: declaredNames.has(targetTool),
      bridgeDeclared: declaredNames.has("tool_search_code"),
      targetResultObserved:
        typeof record.toolOutput === "string" &&
        record.toolOutput.includes("FAKE_PLUGIN_OK") &&
        record.toolOutput.includes(targetTool),
    };
  });
}
