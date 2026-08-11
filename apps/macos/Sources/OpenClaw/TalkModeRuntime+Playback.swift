import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

extension TalkModeRuntime {
    static func makeTalkSpeakParams(
        text: String,
        voiceId: String?,
        modelId: String?,
        outputFormat: String?,
        directive: TalkDirective?) -> [String: AnyCodable]
    {
        var params: [String: AnyCodable] = ["text": AnyCodable(text)]

        func addString(_ key: String, _ value: String?) {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty else { return }
            params[key] = AnyCodable(trimmed)
        }

        addString("voiceId", voiceId)
        addString("modelId", directive?.modelId ?? modelId)
        addString("outputFormat", directive?.outputFormat ?? outputFormat)
        if let speed = directive?.speed {
            params["speed"] = AnyCodable(speed)
        }
        if let rateWPM = directive?.rateWPM {
            params["rateWpm"] = AnyCodable(rateWPM)
        }
        if let stability = directive?.stability {
            params["stability"] = AnyCodable(stability)
        }
        if let similarity = directive?.similarity {
            params["similarity"] = AnyCodable(similarity)
        }
        if let style = directive?.style {
            params["style"] = AnyCodable(style)
        }
        if let speakerBoost = directive?.speakerBoost {
            params["speakerBoost"] = AnyCodable(speakerBoost)
        }
        if let seed = directive?.seed {
            params["seed"] = AnyCodable(seed)
        }
        addString("normalize", directive?.normalize)
        addString("language", directive?.language)
        if let latencyTier = directive?.latencyTier {
            params["latencyTier"] = AnyCodable(latencyTier)
        }

        return params
    }

    // MARK: - Audio playback

    @MainActor
    func playPCM(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        let metered = TalkModeController.shared.meteredSpeechStream(stream, sampleRate: sampleRate)
        let result = await PCMStreamingAudioPlayer.shared.play(stream: metered, sampleRate: sampleRate)
        TalkModeController.shared.endSpeechMetering()
        return result
    }

    /// MP3 streaming has no metering hook; the wave falls back to its floor.
    @MainActor
    func playMP3(stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult {
        await StreamingAudioPlayer.shared.play(stream: stream)
    }

    @MainActor
    func stopPCM() -> Double? {
        PCMStreamingAudioPlayer.shared.stop()
    }

    @MainActor
    func stopMP3() -> Double? {
        StreamingAudioPlayer.shared.stop()
    }

    @MainActor
    func playTalkAudio(data: Data) async -> StreamingPlaybackResult {
        TalkBufferedAudioPlayer.shared.setLevelHandler { level in
            TalkModeController.shared.updateSpeakingLevel(level)
        }
        return await TalkBufferedAudioPlayer.shared.play(data: data)
    }

    @MainActor
    func stopTalkAudio() -> Double? {
        TalkBufferedAudioPlayer.shared.stop()
    }

    func streamMLXVoice(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?,
        referenceAudioPath: String?,
        referenceText: String?,
        stallTimeoutSeconds: Double) async throws -> MLXTTSPlaybackStream
    {
        try await TalkMLXSpeechSynthesizer.shared.synthesizeStream(
            text: text,
            modelRepo: modelRepo,
            language: language,
            voicePreset: voicePreset,
            referenceAudioPath: referenceAudioPath,
            referenceText: referenceText,
            stallTimeoutSeconds: stallTimeoutSeconds)
    }

    func stopMLXVoice() async {
        await TalkMLXSpeechSynthesizer.shared.cancelCurrent()
    }

    // MARK: - Config

    func fetchTalkConfig() async -> TalkModeGatewayConfigState {
        let env = ProcessInfo.processInfo.environment
        let envVoice = env["ELEVENLABS_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sagVoice = env["SAG_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envApiKey = env["ELEVENLABS_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .talkConfig,
                params: ["includeSecrets": AnyCodable(true)],
                timeoutMs: 8000)
            let parsed = TalkModeGatewayConfigParser.parse(
                snapshot: snap,
                defaultProvider: Self.defaultTalkProvider,
                defaultModelIdFallback: Self.defaultModelIdFallback,
                defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs,
                envVoice: envVoice,
                sagVoice: sagVoice,
                envApiKey: envApiKey)
            if parsed.missingResolvedPayload {
                self.ttsLogger.info("talk config ignored: normalized payload missing talk.resolved")
            }
            await MainActor.run {
                AppStateStore.shared.seamColorHex = parsed.seamColorHex
            }
            if parsed.activeProvider == Self.defaultTalkProvider {
                self.ttsLogger.info("talk config provider from talk.resolved")
            } else if parsed.activeProvider == Self.mlxTalkProvider ||
                parsed.activeProvider == Self.systemTalkProvider
            {
                self.ttsLogger.info(
                    "talk provider \(parsed.activeProvider, privacy: .public) active")
            } else {
                self.ttsLogger
                    .info(
                        """
                        talk provider \(parsed.activeProvider, privacy: .public) uses gateway talk.speak \
                        with system voice fallback
                        """)
            }
            return parsed
        } catch {
            return TalkModeGatewayConfigParser.fallback(
                defaultModelIdFallback: Self.defaultModelIdFallback,
                defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs,
                envVoice: envVoice,
                sagVoice: sagVoice,
                envApiKey: envApiKey)
        }
    }
}
