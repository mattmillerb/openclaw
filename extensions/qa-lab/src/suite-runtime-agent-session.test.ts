// Qa Lab tests cover suite runtime agent session plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { appendSqliteSessionTranscriptEventForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
  seedQaSessionTranscript,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

describe("qa suite runtime agent session helpers", () => {
  const gatewayCall = vi.fn();
  const env = {
    gateway: { call: gatewayCall },
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    gatewayCall.mockReset();
  });

  function qaSessionEnv(tempRoot: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };
  }

  async function seedQaSession(params: {
    entry?: Record<string, unknown>;
    sessionId: string;
    sessionKey: string;
    tempRoot: string;
  }) {
    await upsertSessionEntry({
      agentId: "qa",
      env: qaSessionEnv(params.tempRoot),
      sessionKey: params.sessionKey,
      entry: {
        sessionId: params.sessionId,
        updatedAt: 10,
        ...params.entry,
      },
    });
  }

  async function appendQaTranscriptMessage(params: {
    message: unknown;
    sessionId: string;
    sessionKey: string;
    tempRoot: string;
  }) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env: qaSessionEnv(params.tempRoot),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      message: params.message,
    });
  }

  function requireGatewayCall() {
    const [call] = gatewayCall.mock.calls;
    if (!call) {
      throw new Error("expected gateway call");
    }
    return call;
  }

  it("creates sessions and trims the returned key", async () => {
    gatewayCall.mockResolvedValueOnce({ key: "  session-1  " });

    await expect(createSession(env, "Test Session")).resolves.toBe("session-1");
    const [method, params, options] = requireGatewayCall();
    expect(method).toBe("sessions.create");
    expect(params).toEqual({ label: "Test Session" });
    expect(options?.timeoutMs).toBe(60_000);
  });

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("reads skill status for the default qa agent", async () => {
    gatewayCall.mockResolvedValueOnce({
      skills: [{ name: "alpha", eligible: true }],
    });

    await expect(readSkillStatus(env)).resolves.toEqual([{ name: "alpha", eligible: true }]);
    const [method, params, options] = requireGatewayCall();
    expect(method).toBe("skills.status");
    expect(params).toEqual({ agentId: "qa" });
    expect(options?.timeoutMs).toBe(45_000);
  });

  it("reads the raw qa session store from SQLite", async () => {
    const tempRoot = await makeTempDir("qa-session-store-");
    await seedQaSession({
      tempRoot,
      sessionKey: "agent:qa:session-1",
      sessionId: "session-1",
      entry: { status: "running" },
    });

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toEqual({
      "agent:qa:session-1": {
        sessionId: "session-1",
        status: "running",
        updatedAt: 10,
        delivery: { kind: "none" },
      },
    });
  });

  it("reads a requested agent session store", async () => {
    const readEntries = vi.fn(() => []);

    await expect(
      readRawQaSessionStore({ gateway: { tempRoot: "/tmp/qa-agent-store" } } as never, {
        agentId: "alternate",
        readEntries,
        retryDelaysMs: [],
      }),
    ).resolves.toEqual({});
    expect(readEntries).toHaveBeenCalledWith(expect.objectContaining({ agentId: "alternate" }));
  });

  it("retries transient FTS integrity mismatches while child transcripts settle", async () => {
    const readEntries = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(
          'SQLite integrity_check failed for qa.sqlite: fts5: checksum mismatch for table "session_transcript_fts"',
        );
      })
      .mockReturnValueOnce([
        {
          sessionKey: "session-1",
          entry: { sessionId: "session-1", updatedAt: 10 },
        },
      ]);
    vi.useFakeTimers();

    const pending = readRawQaSessionStore(
      { gateway: { tempRoot: "/tmp/qa-fts-settle" } } as never,
      { readEntries, retryDelaysMs: [1] },
    );
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      "session-1": { sessionId: "session-1", updatedAt: 10 },
    });
    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an FTS integrity mismatch does not settle", async () => {
    const mismatch = new Error(
      'SQLite integrity_check failed for qa.sqlite: fts5: checksum mismatch for table "session_transcript_fts"',
    );
    const readEntries = vi.fn(() => {
      throw mismatch;
    });
    vi.useFakeTimers();

    const assertion = expect(
      readRawQaSessionStore({ gateway: { tempRoot: "/tmp/qa-fts-persistent" } } as never, {
        readEntries,
        retryDelaysMs: [1],
      }),
    ).rejects.toThrow(mismatch.message);
    await vi.runAllTimersAsync();

    await assertion;
    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it("seeds QA session metadata and transcript messages in SQLite", async () => {
    const tempRoot = await makeTempDir("qa-session-seed-");
    const sessionId = "seeded-session";
    const sessionKey = "agent:qa:seeded-session";

    await seedQaSessionTranscript(
      {
        gateway: { tempRoot },
      } as never,
      {
        sessionId,
        sessionKey,
        updatedAt: 300,
        label: "Seeded QA transcript",
        messages: [
          { role: "user", text: "What is the codename?", timestamp: 100 },
          { role: "assistant", text: "The codename is ORBIT-10.", timestamp: 200 },
        ],
      },
    );

    const sessionStore = await readRawQaSessionStore({
      gateway: { tempRoot },
    } as never);
    expect(sessionStore).toMatchObject({
      [sessionKey]: {
        sessionId,
        updatedAt: 300,
        origin: { label: "Seeded QA transcript" },
      },
    });
    const transcriptEvents = loadTranscriptEventsSync({
      agentId: "qa",
      env: qaSessionEnv(tempRoot),
      sessionId,
      sessionKey,
    });
    expect(
      transcriptEvents.flatMap((event) => {
        const message = (event as { message?: unknown }).message;
        return message ? [message] : [];
      }),
    ).toEqual([
      {
        role: "user",
        timestamp: 100,
        content: [{ type: "text", text: "What is the codename?" }],
      },
      {
        role: "assistant",
        timestamp: 200,
        content: [{ type: "text", text: "The codename is ORBIT-10." }],
      },
    ]);

    await expect(
      fs.stat(path.join(tempRoot, "state", "agents", "qa", "agent", "openclaw-agent.sqlite")),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(tempRoot, "state", "agents", "qa", "sessions", "sessions.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(tempRoot, "state", "agents", "qa", "sessions", `${sessionId}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports bounded persisted compaction summaries", async () => {
    const tempRoot = await makeTempDir("qa-session-compaction-summaries-");
    const sessionId = "compaction-summary";
    const sessionKey = "agent:qa:compaction-summary";
    const summaries = Array.from({ length: 18 }, (_, index) => `summary-${index}`);
    await seedQaSession({ tempRoot, sessionId, sessionKey });

    let parentId: string | null = null;
    for (const [index, summary] of summaries.entries()) {
      const id = `compaction-${index}`;
      await appendSqliteSessionTranscriptEventForTest({
        agentId: "qa",
        env: qaSessionEnv(tempRoot),
        sessionId,
        sessionKey,
        event: {
          type: "compaction",
          id,
          parentId,
          timestamp: new Date(index).toISOString(),
          summary,
          firstKeptEntryId: id,
          tokensBefore: 100,
        },
      });
      parentId = id;
    }
    await appendQaTranscriptMessage({
      tempRoot,
      sessionId,
      sessionKey,
      message: { role: "assistant", content: "done" },
    });

    const result = await readSessionTranscriptSummary(
      { gateway: { tempRoot } } as never,
      sessionKey,
    );

    expect(result.compactionSummaries).toEqual(summaries.slice(-16));
    expect(result.finalText).toBe("done");
  });

  it("rejects an empty QA session transcript seed", async () => {
    const tempRoot = await makeTempDir("qa-session-seed-empty-");

    await expect(
      seedQaSessionTranscript(
        {
          gateway: { tempRoot },
        } as never,
        {
          sessionId: "seeded-session",
          sessionKey: "agent:qa:seeded-session",
          updatedAt: 100,
          messages: [],
        },
      ),
    ).rejects.toThrow("requires at least one message");
  });

  it("summarizes a QA session transcript by session key", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-");
    const sessionKey = "agent:qa:webchat";
    await seedQaSession({ tempRoot, sessionKey, sessionId: "session-1" });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "message",
            input: { action: "send", text: "hello" },
          },
        ],
        stopReason: "toolUse",
      },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        sessionKey,
      ),
    ).resolves.toEqual({
      assistantToolCallCounts: { message: 1 },
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 2,
      userMessageCount: 0,
      successfulToolCallCounts: {},
      finalText: "",
      hasDirectReplySelfMessage: false,
      lastAssistantContentTypes: ["tool_use"],
      lastAssistantStopReason: "toolUse",
      lastAssistantToolNames: ["message"],
      lastMessageRole: "assistant",
    });

    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-1",
      message: { role: "assistant", content: "Sent." },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:webchat",
      ),
    ).resolves.toEqual({
      assistantToolCallCounts: { message: 1 },
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 3,
      userMessageCount: 0,
      successfulToolCallCounts: {},
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
      lastMessageRole: "assistant",
    });
  });

  it("summarizes QA transcript events after non-assistant rows", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-events-");
    const sessionKey = "agent:qa:stream";
    await seedQaSession({ tempRoot, sessionKey, sessionId: "session-stream" });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
      message: { role: "user", content: "x".repeat(70 * 1024) },
    });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "message",
            input: { action: "send", text: "hello" },
          },
        ],
      },
    });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
      message: {
        role: "assistant",
        content: "Sent.",
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:stream",
      ),
    ).resolves.toEqual({
      assistantToolCallCounts: { message: 1 },
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 4,
      userMessageCount: 1,
      successfulToolCallCounts: {},
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
      lastAssistantErrorMessage: "Request was aborted",
      lastAssistantStopReason: "aborted",
      lastMessageRole: "assistant",
    });
  });

  it("reports provider-owned assistant mirror identities", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-mirrors-");
    const sessionKey = "agent:qa:provider-mirrors";
    await seedQaSession({ tempRoot, sessionKey, sessionId: "session-mirrors" });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-mirrors",
      message: {
        role: "assistant",
        content: "Codex plan:\n- inspect\n- build",
        __openclaw: { mirrorIdentity: "turn-123:plan" },
      },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        sessionKey,
      ),
    ).resolves.toMatchObject({
      assistantMirrors: [
        {
          identity: "turn-123:plan",
          text: "Codex plan:\n- inspect\n- build",
        },
      ],
      finalText: "Codex plan:\n- inspect\n- build",
    });
  });

  it("keeps the provider handoff final when a delivery mirror follows", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-handoff-mirror-");
    const sessionKey = "agent:qa:handoff-mirror";
    const sessionId = "session-handoff-mirror";
    const childResult = "The sidecar verified the requested evidence.";
    const providerFinalText = `Delegated task: qa-sidecar\nResult: ${childResult}\nEvidence: child completed and was delivered.`;
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    for (const message of [
      {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
        content: providerFinalText,
        __openclaw: { mirrorIdentity: "handoff-run:assistant" },
      },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: childResult,
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "handoff-child" },
      },
    ]) {
      await appendQaTranscriptMessage({ tempRoot, sessionKey, sessionId, message });
    }

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, sessionKey),
    ).resolves.toMatchObject({
      assistantMirrors: [{ identity: "handoff-run:assistant", text: providerFinalText }],
      finalText: providerFinalText,
    });
  });

  it("uses a delivery mirror as the final text when no provider reply exists", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-delivery-only-");
    const sessionKey = "agent:qa:delivery-only";
    const sessionId = "session-delivery-only";
    const deliveredText = "A standalone delivered assistant reply.";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId,
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: deliveredText,
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "standalone-delivery" },
      },
    });

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, sessionKey),
    ).resolves.toMatchObject({ finalText: deliveredText });
  });

  it.each([
    ["user", { role: "user", content: "Start the next conversation turn." }],
    [
      "tool result",
      {
        role: "toolResult",
        toolCallId: "next-turn-tool",
        toolName: "message",
        content: [{ type: "text", text: "The next tool turn completed." }],
        isError: false,
      },
    ],
  ])("uses a later delivery-only reply after a %s turn boundary", async (_name, boundary) => {
    const tempRoot = await makeTempDir("qa-session-transcript-next-turn-mirror-");
    const sessionKey = "agent:qa:next-turn-mirror";
    const sessionId = "session-next-turn-mirror";
    const latestDeliveredText = "The later conversation turn was delivered.";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    for (const message of [
      {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
        content: "An earlier provider reply must not win forever.",
        __openclaw: { mirrorIdentity: "earlier-run:assistant" },
      },
      boundary,
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: latestDeliveredText,
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "later-turn" },
      },
    ]) {
      await appendQaTranscriptMessage({ tempRoot, sessionKey, sessionId, message });
    }

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, sessionKey),
    ).resolves.toMatchObject({
      assistantMirrors: [
        {
          identity: "earlier-run:assistant",
          text: "An earlier provider reply must not win forever.",
        },
      ],
      finalText: latestDeliveredText,
    });
  });

  it("keeps the latest genuine provider reply after a new-turn delivery mirror", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-latest-provider-");
    const sessionKey = "agent:qa:latest-provider";
    const sessionId = "session-latest-provider";
    const latestProviderText = "The current provider supplied the final reply.";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    for (const message of [
      { role: "assistant", content: "An earlier provider turn." },
      { role: "user", content: "Start a new turn." },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: "An interim delivery in the new turn.",
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "interim-delivery" },
      },
      { role: "assistant", content: latestProviderText },
    ]) {
      await appendQaTranscriptMessage({ tempRoot, sessionKey, sessionId, message });
    }

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, sessionKey),
    ).resolves.toMatchObject({ finalText: latestProviderText });
  });

  it("counts only correlated non-error tool results as successful", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-tool-results-");
    const sessionKey = "agent:qa:tool-results";
    await seedQaSession({ tempRoot, sessionKey, sessionId: "session-tool-results" });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-tool-results",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "plan-ok", name: "update_plan", arguments: {} },
          { type: "toolCall", id: "plan-error", name: "update_plan", arguments: {} },
          { type: "toolCall", id: "write-mismatch", name: "write", arguments: {} },
        ],
      },
    });
    for (const message of [
      {
        role: "toolResult",
        toolCallId: "plan-ok",
        toolName: "update_plan",
        content: [{ type: "text", text: "Plan updated" }],
        isError: false,
        timestamp: 100,
      },
      {
        role: "toolResult",
        toolCallId: "plan-ok",
        toolName: "update_plan",
        content: [{ type: "text", text: "duplicate" }],
        isError: false,
        timestamp: 200,
      },
      {
        role: "toolResult",
        toolCallId: "plan-error",
        toolName: "update_plan",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 300,
      },
      {
        role: "toolResult",
        toolCallId: "write-mismatch",
        toolName: "exec",
        content: [{ type: "text", text: "wrong tool" }],
        isError: false,
        timestamp: 400,
      },
    ]) {
      await appendQaTranscriptMessage({
        tempRoot,
        sessionKey,
        sessionId: "session-tool-results",
        message,
      });
    }

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        sessionKey,
      ),
    ).resolves.toMatchObject({
      assistantToolCallCounts: { update_plan: 2, write: 1 },
      completedToolCallCounts: { update_plan: 2 },
      successfulToolCallCounts: { update_plan: 1 },
      successfulToolCallEvents: [{ name: "update_plan", timestamp: 100, toolCallId: "plan-ok" }],
    });
  });

  it("only exposes authenticated successful tool results with finite owner timestamps", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-tool-event-timestamps-");
    const sessionKey = "agent:qa:tool-event-timestamps";
    const sessionId = "session-tool-event-timestamps";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId,
      message: {
        role: "assistant",
        content: ["missing", "invalid", "valid"].map((id) => ({
          type: "toolCall",
          id,
          name: "exec",
          arguments: {},
        })),
      },
    });

    for (const [toolCallId, timestamp] of [
      ["missing", undefined],
      ["invalid", "not-a-number"],
      ["valid", 300],
    ] as const) {
      await appendQaTranscriptMessage({
        tempRoot,
        sessionKey,
        sessionId,
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "exec",
          isError: false,
          ...(timestamp === undefined ? {} : { timestamp }),
        },
      });
    }

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, sessionKey),
    ).resolves.toMatchObject({
      successfulToolCallCounts: { exec: 3 },
      successfulToolCallEvents: [{ name: "exec", timestamp: 300, toolCallId: "valid" }],
    });
  });

  it("bounds authenticated successful tool results to the latest 64 events", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-tool-event-bound-");
    const sessionKey = "agent:qa:tool-event-bound";
    const sessionId = "session-tool-event-bound";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId,
      message: {
        role: "assistant",
        content: Array.from({ length: 65 }, (_, index) => ({
          type: "toolCall",
          id: `call-${index}`,
          name: "exec",
          arguments: {},
        })),
      },
    });

    for (let index = 0; index < 65; index += 1) {
      await appendQaTranscriptMessage({
        tempRoot,
        sessionKey,
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "exec",
          isError: false,
          timestamp: index,
        },
      });
    }

    const summary = await readSessionTranscriptSummary(
      { gateway: { tempRoot } } as never,
      sessionKey,
    );

    expect(summary.successfulToolCallCounts).toEqual({ exec: 65 });
    expect(summary.successfulToolCallEvents).toHaveLength(64);
    expect(summary.successfulToolCallEvents?.[0]).toEqual({
      name: "exec",
      timestamp: 1,
      toolCallId: "call-1",
    });
    expect(summary.successfulToolCallEvents?.at(-1)).toEqual({
      name: "exec",
      timestamp: 64,
      toolCallId: "call-64",
    });
  });

  it("scopes transcript evidence after an event cursor", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-cursor-");
    const sessionKey = "agent:qa:cursor";
    const sessionId = "session-cursor";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    for (const message of [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "old-plan", name: "update_plan", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "old-plan",
        toolName: "update_plan",
        content: [{ type: "text", text: "Plan updated" }],
        isError: false,
        timestamp: 100,
      },
      {
        role: "assistant",
        content: "same visible reply",
        __openclaw: { mirrorIdentity: "old-turn:assistant" },
      },
    ]) {
      await appendQaTranscriptMessage({ tempRoot, sessionKey, sessionId, message });
    }
    const checkpoint = await readSessionTranscriptSummary(
      { gateway: { tempRoot } } as never,
      sessionKey,
    );
    expect(checkpoint.successfulToolCallEvents).toEqual([
      { name: "update_plan", timestamp: 100, toolCallId: "old-plan" },
    ]);
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId,
      message: {
        role: "assistant",
        content: "same visible reply",
        __openclaw: { mirrorIdentity: "current-turn:assistant" },
      },
    });

    const summary = await readSessionTranscriptSummary(
      { gateway: { tempRoot } } as never,
      sessionKey,
      { afterEventCursor: checkpoint.eventCursor },
    );

    expect(summary).toMatchObject({
      assistantMirrors: [{ identity: "current-turn:assistant", text: "same visible reply" }],
      assistantToolCallCounts: {},
      eventCursor: 5,
      successfulToolCallCounts: {},
    });
    expect(summary.successfulToolCallEvents).toBeUndefined();
  });

  it("returns an empty checkpoint before the session exists", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-checkpoint-");

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, "agent:qa:not-created-yet", {
        allowEmpty: true,
      }),
    ).resolves.toEqual({
      assistantToolCallCounts: {},
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 0,
      userMessageCount: 0,
      successfulToolCallCounts: {},
      finalText: "",
      hasDirectReplySelfMessage: false,
    });
  });

  it("fails closed when a requested QA session transcript is empty", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-empty-");
    await seedQaSession({
      tempRoot,
      sessionKey: "agent:qa:empty",
      sessionId: "session-empty",
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:empty",
      ),
    ).rejects.toThrow("session transcript is empty");
  });

  it("fails closed when a requested QA session transcript entry is missing", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-missing-");

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:missing",
      ),
    ).rejects.toThrow("session transcript entry not found");
  });

  it("returns an empty session store when the file does not exist", async () => {
    const tempRoot = await makeTempDir("qa-session-store-missing-");

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toStrictEqual({});
  });
});
