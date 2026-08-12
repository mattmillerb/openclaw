import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
private final class UnusedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class DrainingPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate _: Double) async -> StreamingPlaybackResult {
        do {
            for try await _ in stream {}
        } catch {}
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class TestRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    var suppressesInputDuringOutput = false
    private(set) var isStarted = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private var onFailure: (@MainActor (String) -> Void)?

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        self.isStarted = true
        self.startCount += 1
        self.onFailure = onFailure
    }

    func stop() {
        self.isStarted = false
        self.stopCount += 1
        self.onFailure = nil
    }

    func fail(_ message: String) {
        self.onFailure?(message)
    }
}

private actor RealtimeRelayStartupBarrier {
    private var entered = false
    private var enteredWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func suspend() async {
        self.entered = true
        self.enteredWaiter?.resume()
        self.enteredWaiter = nil
        await withCheckedContinuation { self.releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { self.enteredWaiter = $0 }
    }

    func release() {
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private struct RealtimeRelayStartupRequest: Sendable {
    let method: String
    let params: [String: AnyCodable]?
}

private actor RealtimeRelayStartupRequestLog {
    private var requests: [RealtimeRelayStartupRequest] = []

    func record(method: String, params: [String: AnyCodable]?) {
        self.requests.append(RealtimeRelayStartupRequest(method: method, params: params))
    }

    func snapshot() -> [RealtimeRelayStartupRequest] {
        self.requests
    }
}

private actor RealtimeRelayRouteFlag {
    private var isCurrent = true

    func expire() {
        self.isCurrent = false
    }

    func value() -> Bool {
        self.isCurrent
    }
}

private actor RealtimeRelayEventSource {
    private var continuation: AsyncStream<EventFrame>.Continuation?

    func stream() -> AsyncStream<EventFrame> {
        AsyncStream { self.continuation = $0 }
    }

    func finish() {
        self.continuation?.finish()
    }
}

private func unusedRealtimeRelayTransport() -> RealtimeTalkRelayTransport {
    RealtimeTalkRelayTransport(
        subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
        request: { _, _, _ in throw CancellationError() })
}

private func outputAudioEvent(generation: Int) -> EventFrame {
    EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable([
            "relaySessionId": "relay-1",
            "type": "audio",
            "audioBase64": Data([0x01]).base64EncodedString(),
            "outputGeneration": generation,
        ]),
        seq: nil,
        stateversion: nil)
}

@MainActor
struct RealtimeTalkRelaySessionTests {
    enum CancellationRetirement {
        case clear
        case close
    }

    private func makeIdleCancellationSession(
        _ onSpeakingChanged: @escaping (Bool) -> Void) -> RealtimeTalkRelaySession
    {
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { _, _, _ in Data("{\"ok\":true}".utf8) })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: onSpeakingChanged)
        session._test_setRelaySessionId("relay-1")
        return session
    }

    private func makeAudioSendSession() -> (RealtimeTalkRelaySession, RealtimeRelayStartupRequestLog) {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        return (session, requests)
    }

    @Test func `transcript callback carries typed partial and final values`() async {
        var transcripts: [RealtimeTalkTranscript] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            onTranscript: { transcripts.append($0) })
        session._test_setRelaySessionId("relay-1")

        for isFinal in [false, true] {
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "transcript",
                    "role": "user",
                    "text": isFinal ? "hello" : "hel",
                    "final": isFinal,
                ]),
                seq: nil,
                stateversion: nil))
        }

        #expect(transcripts == [
            RealtimeTalkTranscript(role: "user", text: "hel", isFinal: false),
            RealtimeTalkTranscript(role: "user", text: "hello", isFinal: true),
        ])
    }

    @Test func `input pause and resume are idempotent and keep relay alive`() throws {
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        try session.setInputPaused(true)
        try session.setInputPaused(true)
        try session.setInputPaused(false)
        try session.setInputPaused(false)

        #expect(audioCapture.stopCount == 2)
        #expect(audioCapture.startCount == 1)
        #expect(audioCapture.isStarted)
    }

    @Test func `output playback finish clears barge in start time`() {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session._test_markOutputAudioStarted(nowMs: 100)
        #expect(session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == 100)

        session._test_markOutputPlaybackFinished()
        #expect(!session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == nil)
        #expect(speakingStates == [false])

        session._test_markOutputAudioStarted(nowMs: 500)
        #expect(session._test_outputStartedAtMs() == 500)
    }

    @Test func `playback mark is acknowledged after output finishes`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_markOutputAudioStarted(nowMs: 100)

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "mark",
                "markName": "audio-1",
            ]),
            seq: nil,
            stateversion: nil))
        await Task.yield()
        #expect(await requests.snapshot().isEmpty)

        session._test_markOutputPlaybackFinished()
        for _ in 0..<10 {
            if await !(requests.snapshot()).isEmpty { break }
            await Task.yield()
        }

        let recorded = await requests.snapshot()
        #expect(recorded.count == 1)
        let request = try #require(recorded.first)
        #expect(request.method == "talk.session.acknowledgeMark")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["markName"]?.stringValue == "audio-1")
    }
}

extension RealtimeTalkRelaySessionTests {
    @Test func `output cancellation fences delayed audio and preserves exact identity`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            },
            supportsOutputGeneration: { true })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        let audio: (Int, String) -> EventFrame = { generation, turnId in
            EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "audio",
                    "audioBase64": Data([0x01]).base64EncodedString(),
                    "outputGeneration": generation,
                    "talkEvent": ["turnId": turnId],
                ]),
                seq: nil,
                stateversion: nil)
        }
        let clear: (Int) -> EventFrame = { generation in
            EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "clear",
                    "outputGeneration": generation,
                ]),
                seq: nil,
                stateversion: nil)
        }

        await session._test_handleGatewayEvent(audio(7, "turn-7"))
        session.cancelOutput(reason: "barge-in")
        for _ in 0..<10 {
            if await !requests.snapshot().isEmpty { break }
            await Task.yield()
        }
        let request = try #require(await requests.snapshot().first)
        #expect(request.method == "talk.session.cancelOutput")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["outputGeneration"]?.doubleValue == 7)
        #expect(request.params?["reason"]?.stringValue == "barge-in")

        await session._test_handleGatewayEvent(audio(7, "turn-7"))
        await session._test_handleGatewayEvent(audio(8, "turn-8"))
        #expect(speakingStates.first == true)
        #expect(!speakingStates.dropFirst().contains(true))
        await session._test_handleGatewayEvent(clear(7))
        await session._test_handleGatewayEvent(audio(7, "turn-7"))
        #expect(speakingStates == [true, false])
        await session._test_handleGatewayEvent(audio(8, "turn-8"))
        #expect(speakingStates == [true, false, true])
        await session._test_handleGatewayEvent(clear(7))
        #expect(speakingStates == [true, false, true])
        await session._test_handleGatewayEvent(clear(8))
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `legacy cancellation keeps turn identity but omits generation`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "outputGeneration": 7,
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))

        session.cancelOutput(reason: "barge-in")
        for _ in 0..<10 {
            if await !requests.snapshot().isEmpty { break }
            await Task.yield()
        }
        let request = try #require(await requests.snapshot().first)
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["outputGeneration"] == nil)
    }

    @Test func `idle cancellation and pause retain the relay without false interruption`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            },
            supportsOutputGeneration: { true })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        session.setOutputPaused(true)
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))
        #expect(speakingStates.isEmpty)
        #expect(await requests.snapshot().isEmpty)
        session.setOutputPaused(false)
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 2))
        #expect(speakingStates == [true])
        #expect(await requests.snapshot().isEmpty)
    }

    @Test func `idle cancellation waits for clear while cancellation without relay stays unfenced`() async {
        var speakingStates: [Bool] = []
        let session = self.makeIdleCancellationSession { speakingStates.append($0) }
        session.cancelOutput(reason: "barge-in")
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))
        #expect(speakingStates == [false])
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))
        #expect(speakingStates == [false, true])

        var unfencedStates: [Bool] = []
        let unfenced = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { unfencedStates.append($0) })
        unfenced.cancelOutput()
        unfenced._test_setRelaySessionId("relay-1")
        await unfenced._test_handleGatewayEvent(outputAudioEvent(generation: 1))
        #expect(unfencedStates == [true])
    }

    @Test func `active output pause cancels the exact generation`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    return Data("{\"ok\":true}".utf8)
                },
                supportsOutputGeneration: { true }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "outputGeneration": 7,
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))

        session.setOutputPaused(true)
        for _ in 0..<10 {
            if await !requests.snapshot().isEmpty { break }
            await Task.yield()
        }
        let request = try #require(await requests.snapshot().first)
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["outputGeneration"]?.doubleValue == 7)
        #expect(request.params?["reason"]?.stringValue == "pause")
    }

    @Test func `current cancellation failure terminates and rejects late audio`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.cancelOutput" {
                    throw URLError(.cannotConnectToHost)
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))

        session.cancelOutput()
        for _ in 0..<50 {
            if !issues.isEmpty { break }
            await Task.yield()
        }
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 2))
        for _ in 0..<50 {
            if await requests.snapshot().contains(where: { $0.method == "talk.session.close" }) { break }
            await Task.yield()
        }

        #expect(issues.map(\.code) == ["realtime_output_cancel_failed"])
        #expect(issues.map(\.phase) == ["output-cancel"])
        #expect(terminations == [.outputCancellationFailed])
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
        #expect(speakingStates.first == true)
        #expect(!speakingStates.dropFirst().contains(true))
    }

    @Test func `superseded cancellation failure leaves the active fence intact`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if await requests.snapshot().count == 1 {
                    await barrier.suspend()
                    throw URLError(.cancelled)
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        session.cancelOutput()
        await barrier.waitUntilEntered()
        session.cancelOutput()
        await barrier.release()
        for _ in 0..<10 {
            if await requests.snapshot().count == 2 { break }
            await Task.yield()
        }
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))

        #expect(issues.isEmpty)
        #expect(await requests.snapshot().count == 2)
        #expect(!speakingStates.contains(true))
    }

    @Test(arguments: [CancellationRetirement.clear, .close])
    func `clear and close retire in flight cancellation failures`(
        retirement: CancellationRetirement) async
    {
        let barrier = RealtimeRelayStartupBarrier()
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in
                    if method == "talk.session.cancelOutput" {
                        await barrier.suspend()
                        throw URLError(.cancelled)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        session.cancelOutput()
        await barrier.waitUntilEntered()
        switch retirement {
        case .clear:
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "clear",
                ]),
                seq: nil,
                stateversion: nil))
        case .close:
            session.stop()
        }
        await barrier.release()
        await Task.yield()

        #expect(issues.isEmpty)
    }

    @Test func `close after classified error does not replace issue`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "code": "realtime_unavailable",
                "provider": "openai",
                "model": "gpt-realtime-2",
                "transport": "gateway-relay",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "error",
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.code) == ["realtime_unavailable"])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func `pre-ready relay failure throws and closes created session`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let failureEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                AsyncStream { continuation in
                    continuation.yield(failureEvent)
                }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("Expected the pre-ready relay failure to throw")
        } catch {
            #expect(error.localizedDescription == "OpenAI API key rejected with 401")
        }

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!audioCapture.isStarted)
    }

    @Test func `pre-ready event stream end promptly fails startup and closes created session once`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let eventChannel = AsyncStream<EventFrame>.makeStream()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in eventChannel.stream },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in try await session.start() }
        while !audioCapture.isStarted {
            await Task.yield()
        }

        let disconnectedAt = ContinuousClock.now
        eventChannel.continuation.finish()
        do {
            try await start.value
            Issue.record("Expected the pre-ready event stream end to throw")
        } catch {
            #expect(error.localizedDescription == "Realtime connection ended before it became ready.")
        }

        #expect(disconnectedAt.duration(to: .now) < .seconds(1))
        #expect(issues.map(\.phase) == ["connect"])
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!audioCapture.isStarted)
    }

    @Test func `event stream ending during relay creation closes the late relay`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in await events.stream() },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.create" {
                        await barrier.suspend()
                        return resultData
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in
            do {
                try await session.start()
                return nil as String?
            } catch {
                return error.localizedDescription
            }
        }
        await barrier.waitUntilEntered()

        await events.finish()
        while issues.isEmpty {
            await Task.yield()
        }
        await barrier.release()

        #expect(await start.value == "Realtime connection ended before it became ready.")
        #expect(audioCapture.startCount == 0)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `microphone failure terminates relay and reports typed issue`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { _ in } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        try session._test_startMicrophonePump()

        audioCapture.fail("Realtime microphone became unavailable: no input")
        for _ in 0..<10 {
            if await !(requests.snapshot()).isEmpty { break }
            await Task.yield()
        }

        #expect(issues.map(\.code) == ["audio_input_unavailable"])
        #expect(issues.map(\.phase) == ["audio-input"])
        #expect(terminations == [.audioCaptureFailed(
            message: "Realtime microphone became unavailable: no input")])
        #expect(!audioCapture.isStarted)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.close"])
        #expect(recorded.first?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `ready then close publishes one typed termination and releases capture`() async {
        var statuses: [String] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        let closeEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "completed",
            ]),
            seq: nil,
            stateversion: nil)
        await session._test_handleGatewayEvent(closeEvent)
        await session._test_handleGatewayEvent(closeEvent)

        #expect(statuses == ["Listening (Realtime)", "Ready"])
        #expect(terminations == [.remoteClose(reason: "completed")])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `ready then event stream end publishes typed termination`() async {
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleEventStreamEnded()
        await session._test_handleEventStreamEnded()

        #expect(terminations == [.eventStreamEnded])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `closed relay does not wait for startup ready`() async {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func `startup ready wait covers gateway connect budget`() {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        #expect(session._test_startupReadyTimeoutSeconds() >= 12)
    }

    @Test func `stop during event subscription prevents relay creation`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                await barrier.suspend()
                return AsyncStream { $0.finish() }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                throw URLError(.badServerResponse)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        #expect(await requests.snapshot().isEmpty)
        #expect(statuses == ["Connecting realtime…"])
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during relay creation closes late session once`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!statuses.contains("Waiting for realtime…"))
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during buffered tool call prevents late relay side effects`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.client.toolCall" {
                    await barrier.suspend()
                    return Data("{\"runId\":\"run-1\"}".utf8)
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        let handling = Task { @MainActor in
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "toolCall",
                    "callId": "call-1",
                    "name": "lookup",
                    "args": [:],
                ]),
                seq: nil,
                stateversion: nil))
        }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        await handling.value
        await session._test_waitForToolCalls()

        let methods = await requests.snapshot().map(\.method)
        #expect(methods.first == "talk.client.toolCall")
        #expect(!methods.contains("talk.session.submitToolResult"))
        #expect(statuses == ["Thinking…"])
    }

    @Test func `stop and pause discard buffered microphone audio before dispatch`() async throws {
        let (stoppedSession, stoppedRequests) = self.makeAudioSendSession()
        let stoppedSend = try #require(stoppedSession._test_enqueueMicrophoneFrame(Data([0x01])))

        stoppedSession.stop()
        await stoppedSend.value
        #expect(await stoppedRequests.snapshot().isEmpty)

        let (session, requests) = self.makeAudioSendSession()
        _ = try #require(session._test_enqueueMicrophoneFrame(Data([0x01])))
        try session.setInputPaused(true)
        try session.setInputPaused(false)
        try await (#require(session._test_enqueueMicrophoneFrame(Data([0x02])))).value

        #expect(await requests.snapshot().compactMap { $0.params?["audioBase64"]?.stringValue } == [
            Data([0x02]).base64EncodedString(),
        ])
    }

    @Test func `gateway route lost during startup fails instead of reporting ready`() async throws {
        let route = RealtimeRelayRouteFlag()
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in
                    // The Gateway replaces the route immediately after the subscription lands.
                    await route.expire()
                    return AsyncStream { $0.finish() }
                },
                request: { _, _, _ in Data("{\"ok\":true}".utf8) },
                isCurrent: { await route.value() }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("Expected a lost Gateway route to fail startup")
        } catch is CancellationError {
            // The runtime returns silently on CancellationError, so classifying route loss as
            // cancellation would leave Talk marked listening with no relay and no fallback.
            Issue.record("Route loss must not surface as local cancellation")
        } catch {
            #expect(
                error.localizedDescription ==
                    "Gateway connection was replaced before realtime startup finished")
        }

        #expect(!audioCapture.isStarted)
    }

    @Test func `appended audio timestamps stay whole milliseconds`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_prepareAudioSender(relaySessionId: "relay-1")

        // macOS taps stamp frames with `systemUptime * 1000`, so the raw value is fractional.
        let send = try #require(
            session._test_enqueueMicrophoneFrame(Data([0x01, 0x02]), timestampMs: 4823.617))
        await send.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.appendAudio"])
        // A decimal reaches the provider as a non-integer `audio_end_ms` and its
        // `conversation.item.truncate` is rejected, ending the session on the first barge-in.
        let timestamp = try #require(recorded.first?.params?["timestamp"]?.value as? Double)
        #expect(timestamp == 4824)
        #expect(timestamp == timestamp.rounded())
    }
}
