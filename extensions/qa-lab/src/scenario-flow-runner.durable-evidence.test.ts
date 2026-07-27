// QA Lab durable-evidence tests keep live subagent and memory claims tied to current artifacts.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  formatTestTranscript,
  runLoadedScenarioFlow,
} from "./scenario-flow-runner.test-support.js";

const durableSubagentScenarioIds = ["subagent-handoff", "subagent-forked-context"] as const;

type HandoffEvidenceOverrides = {
  childOwner?: string;
  childLabel?: string;
  childFinalText?: string;
  taskOwner?: string;
  taskChildSessionKey?: string;
  taskLabel?: string;
  taskStatus?: string;
  forkChildOwner?: string;
  fallbackTaskOwner?: string;
  fallbackTaskChildSessionKey?: string;
  fallbackTaskLabel?: string;
  initialParentResult?: string;
  mockRequestText?: string;
  parentFinalText?: string;
  parentResult?: string;
  parentEvidence?: string;
};

function runDurableSubagentEvidenceFixture(
  scenarioId: (typeof durableSubagentScenarioIds)[number],
  withCompletedChildren: boolean,
  handoffOverrides: HandoffEvidenceOverrides = {},
) {
  const state = createQaBusState();
  const handoffParentSessionKey = "agent:qa:subagent-handoff:00000000";
  const handoffChildSessionKey = "agent:qa:handoff-child";
  const handoffChildLabel = "qa-sidecar";
  const handoffChildFinalText =
    handoffOverrides.childFinalText ?? "<prompt-data>\nchild finished\n</prompt-data>";
  const handoffParentResult = handoffOverrides.parentResult ?? "child finished";
  const handoffText = [
    "Delegated task: bounded QA task",
    `Result: ${handoffParentResult}`,
    `Evidence: ${handoffOverrides.parentEvidence ?? "successful child result confirmed"}`,
  ].join("\n");
  const initialHandoffText = [
    "Delegated task: bounded QA task",
    `Result: ${handoffOverrides.initialParentResult ?? handoffParentResult}`,
    `Evidence: ${handoffOverrides.parentEvidence ?? "successful child result confirmed"}`,
  ].join("\n");
  const forkedText = "FORKED-CONTEXT-ALPHA";
  const directText = "QA-SUBAGENT-DIRECT-FALLBACK-OK";
  const fanoutText = "subagent-1: ok\nsubagent-2: ok";
  const childFinalTexts: Record<string, string> = {
    [handoffChildSessionKey]: handoffChildFinalText,
    "agent:qa:forked-child": forkedText,
    "agent:qa:fanout-child:alpha": "ok",
    "agent:qa:fanout-child:beta": "ok",
  };
  const childStore: Record<string, { spawnedBy: string; label: string }> = {
    [handoffChildSessionKey]: {
      spawnedBy: handoffOverrides.childOwner ?? handoffParentSessionKey,
      label: handoffOverrides.childLabel ?? handoffChildLabel,
    },
    "agent:qa:forked-child": {
      spawnedBy: handoffOverrides.forkChildOwner ?? "agent:qa:forked-context:00000000",
      label: "qa-forked-worker",
    },
    "agent:qa:direct-child": {
      spawnedBy: "agent:qa:subagent-direct-fallback:00000000",
      label: "qa-direct-fallback-worker",
    },
    "agent:qa:fanout-child:alpha": {
      spawnedBy: "agent:qa:fanout:1:00000000",
      label: "qa-fanout-alpha-1",
    },
    "agent:qa:fanout-child:beta": {
      spawnedBy: "agent:qa:fanout:1:00000000",
      label: "qa-fanout-beta-1",
    },
  };

  return runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      env: {
        providerMode: "live-frontier",
        gateway: { runtimeEnv: {} },
        ...(handoffOverrides.mockRequestText
          ? { mock: { baseUrl: "http://qa.mock.invalid" } }
          : {}),
      },
      fetchJson: async () => [
        {
          allInputText: handoffOverrides.mockRequestText,
          hasReadableCompletedHandoffResult: Boolean(handoffOverrides.mockRequestText),
          emittedAssistantHasResultSection: Boolean(handoffOverrides.mockRequestText),
        },
      ],
      normalizeLowercaseStringOrEmpty,
      formatErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
      recentOutboundSummary: () => formatTestTranscript(state),
      runAgentPrompt: async () => {
        const text =
          scenarioId === "subagent-handoff"
            ? initialHandoffText
            : scenarioId === "subagent-forked-context"
              ? forkedText
              : scenarioId === "subagent-completion-direct-fallback"
                ? directText
                : fanoutText;
        state.addOutboundMessage({ accountId: "qa-channel", to: "dm:qa-operator", text });
      },
      waitForAgentHistoryReply: async () => ({ text: initialHandoffText }),
      readRawQaSessionStore: async () => (withCompletedChildren ? childStore : {}),
      readSessionTranscriptSummary: async (_env: unknown, sessionKey: string) => ({
        finalText:
          sessionKey === handoffParentSessionKey
            ? (handoffOverrides.parentFinalText ?? handoffText)
            : (childFinalTexts[sessionKey] ?? fanoutText),
      }),
      runQaCli: async () => ({
        tasks: withCompletedChildren
          ? [
              {
                requesterSessionKey: handoffOverrides.taskOwner ?? handoffParentSessionKey,
                childSessionKey: handoffOverrides.taskChildSessionKey ?? handoffChildSessionKey,
                label: handoffOverrides.taskLabel ?? handoffChildLabel,
                status: handoffOverrides.taskStatus ?? "succeeded",
                deliveryStatus: "delivered",
              },
              {
                requesterSessionKey:
                  handoffOverrides.fallbackTaskOwner ??
                  "agent:qa:subagent-direct-fallback:00000000",
                childSessionKey:
                  handoffOverrides.fallbackTaskChildSessionKey ?? "agent:qa:direct-child",
                label: handoffOverrides.fallbackTaskLabel ?? "qa-direct-fallback-worker",
                deliveryStatus: "delivered",
                status: "succeeded",
              },
            ]
          : [],
      }),
    },
  });
}

describe("scenario flow durable evidence", () => {
  it.each(durableSubagentScenarioIds)(
    "rejects a fabricated live parent reply without completed children for %s",
    async (scenarioId) => {
      await expect(runDurableSubagentEvidenceFixture(scenarioId, false)).rejects.toThrow(
        "test condition was not met",
      );
    },
  );

  it.each(durableSubagentScenarioIds)(
    "accepts causally owned completed live children for %s",
    async (scenarioId) => {
      await expect(runDurableSubagentEvidenceFixture(scenarioId, true)).resolves.toMatchObject({
        status: "pass",
      });
    },
  );

  it.each([
    ["wrong handoff child label", "subagent-handoff", { childLabel: "qa-stale" }],
    ["stale handoff requester", "subagent-handoff", { taskOwner: "agent:qa:old" }],
    ["wrong handoff child task", "subagent-handoff", { taskChildSessionKey: "agent:qa:old" }],
    ["wrong handoff task label", "subagent-handoff", { taskLabel: "qa-stale" }],
    ["empty child", "subagent-handoff", { childFinalText: "<prompt-data></prompt-data>" }],
    ["fabricated handoff result", "subagent-handoff", { parentResult: "fabricated" }],
    ["unattributed handoff evidence", "subagent-handoff", { parentEvidence: "done" }],
    ["split final reply", "subagent-handoff", { parentFinalText: "child finished" }],
    ["accepted-only handoff result", "subagent-handoff", { parentResult: '{"status":"accepted"}' }],
    ["old fork", "subagent-forked-context", { forkChildOwner: "agent:qa:forked-context" }],
  ] satisfies Array<
    [string, (typeof durableSubagentScenarioIds)[number], HandoffEvidenceOverrides]
  >)("rejects durable subagent false positives from %s", async (_name, scenarioId, overrides) => {
    await expect(runDurableSubagentEvidenceFixture(scenarioId, true, overrides)).rejects.toThrow(
      "test condition was not met",
    );
  });

  it("verifies the completed parent handoff instead of its earlier spawn-acceptance reply", async () => {
    await expect(
      runDurableSubagentEvidenceFixture("subagent-handoff", true, {
        initialParentResult: '{"status":"accepted","childSessionKey":"agent:qa:handoff-child"}',
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("reports a failed current handoff task without exposing its transcript", async () => {
    const privateChildResult = "QA_PRIVATE_CHILD_RESULT_DO_NOT_LOG";
    const failedHandoff = runDurableSubagentEvidenceFixture("subagent-handoff", true, {
      childFinalText: privateChildResult,
      mockRequestText: `Delegate one bounded QA task\n[Internal task completion event]\nsource: subagent\ntask: qa-sidecar\nstatus: completed; ready for parent review\nChild result:\n<prompt-data>${privateChildResult}</prompt-data>`,
      taskStatus: "failed",
    });
    await expect(failedHandoff).rejects.toThrow(
      /"hasInternalCompletionMarker":true[\s\S]*"hasSuccessfulStatus":true[\s\S]*"hasPromptData":true[\s\S]*"hasReadableCompletedHandoffResult":true[\s\S]*"emittedAssistantHasResultSection":true/,
    );
    await expect(failedHandoff).rejects.not.toThrow(privateChildResult);
  });

  it("reports stale child ownership without crediting an earlier handoff attempt", async () => {
    await expect(
      runDurableSubagentEvidenceFixture("subagent-handoff", true, {
        childOwner: "agent:qa:subagent-handoff:previous",
      }),
    ).rejects.toThrow(/requester=agent:qa:subagent-handoff:00000000;[\s\S]*children=\[\]/);
  });

  it("reports missing child attribution as section flags without leaking parent text", async () => {
    const privateParentEvidence = "QA_PRIVATE_PARENT_EVIDENCE_DO_NOT_LOG";
    const run = () =>
      runDurableSubagentEvidenceFixture("subagent-handoff", true, {
        parentEvidence: privateParentEvidence,
      });
    await expect(run()).rejects.toThrow(
      /sections=\{[^}]*"evidence":true[^}]*"attributesChild":false/,
    );
    await expect(run()).rejects.not.toThrow(privateParentEvidence);
  });
});
