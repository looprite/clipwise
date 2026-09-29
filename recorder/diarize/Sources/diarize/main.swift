// Splits the call-audio (tap) track into per-voice labels after a capture
// (SAA-194). Spawned by server/src/pipeline/diarize.ts as its own pipeline
// step, after ingest and before extract — never by main.js, and never
// blocking or failing a capture: any error here is written to the sidecar's
// `error` field and the caller treats that as "nothing to apply", not as a
// pipeline failure.
//
// Usage: diarize <tap-16k.wav> <mic-16k.wav> <models-dir> <output.json>
//
// The mic file is used only for the host-echo check (SAA-194 §4): a short
// clip of the host talking alone, diarized the same way, to find the
// dropped voice on the tap track that's really the host's own leakage.
//
// No network, ever. `ModelHub.offlineMode = true` is set before the models
// are loaded — with it on, a missing or revision-mismatched cache throws a
// typed error instead of FluidAudio silently reaching HuggingFace (or, worse,
// deleting files at `models-dir` to make room for a redownload). The models
// directory itself is populated ahead of time by fetch-models.sh, never by
// this tool.

import AVFoundation
import FluidAudio
import Foundation

let arguments = CommandLine.arguments

// Maintenance-only path, used by fetch-models.sh, never by the pipeline: the
// one place in this whole tool where a network fetch is allowed.
// `OfflineDiarizerModels.load(from:)` downloads-if-missing/mismatched when
// `ModelHub.offlineMode` is left at its default (false) — this just calls it
// against a real HuggingFace connection and lets that happen, populating
// `<dir>` with the 7 model files, config.json, provenance.json and the
// `.fluidaudio-revision` marker the runtime path below requires.
if arguments.count == 3, arguments[1] == "--fetch-models" {
    // Same parent-directory convention as the runtime path above: the files
    // land at <targetParentDir>/speaker-diarization/, not directly in it.
    let targetParentDir = URL(fileURLWithPath: arguments[2])
    do {
        _ = try await OfflineDiarizerModels.load(from: targetParentDir)
        print("diarize: fetched models into \(targetParentDir.path)/speaker-diarization")
    } catch {
        FileHandle.standardError.write("diarize: fetch failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    exit(0)
}

// Regression check for clipExclusionRanges (SAA-199, 2026-09-29), the same
// plain-script/exit-code shape as pipeline/check-match-calendar.ts on the
// server side: no models, no audio, no live dependency — just the pure
// function against the three cases its own comment describes.
//
// Usage: diarize --check-clip-exclusion
if arguments.count == 2, arguments[1] == "--check-clip-exclusion" {
    struct Case { let name: String; let hostVoiceRanges: [ClipRange]; let micSpeechRanges: [(Double, Double)]; let expected: [(Double, Double)] }
    let cases: [Case] = [
        Case(
            name: "no host reference at all -> exclude all mic speech",
            hostVoiceRanges: [], micSpeechRanges: [(0, 10), (20, 30)],
            expected: [(0, 10), (20, 30)]),
        Case(
            name: "reference existed, no cluster reached the cut-off -> exclude all mic speech",
            hostVoiceRanges: [], micSpeechRanges: [(5, 12)],
            expected: [(5, 12)]),
        Case(
            name: "reference with host cluster(s) found -> exclude only the host ranges",
            hostVoiceRanges: [ClipRange(start: 5, end: 8)], micSpeechRanges: [(0, 10), (20, 30)],
            expected: [(5, 8)]),
    ]
    var failures = 0
    for c in cases {
        let got = clipExclusionRanges(hostVoiceRanges: c.hostVoiceRanges, micSpeechRanges: c.micSpeechRanges)
        let ok = got.count == c.expected.count
            && zip(got, c.expected).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        print("\(ok ? "PASS" : "FAIL") \(c.name): got \(got)")
        if !ok { failures += 1 }
    }
    print("\n\(cases.count - failures)/\(cases.count) passed")
    exit(failures == 0 ? 0 : 1)
}

#if arch(arm64)
#else
FileHandle.standardError.write(
    "diarize: skipped — Apple Silicon only, this Mac's arch is not arm64\n".data(using: .utf8)!)
exit(3)
#endif

guard arguments.count == 5 else {
    FileHandle.standardError.write(
        "usage: diarize <tap-16k.wav> <mic-16k.wav> <models-dir> <output.json>\n".data(
            using: .utf8)!)
    exit(2)
}
let tapPath = arguments[1]
let micPath = arguments[2]
// The PARENT of where the models actually live. FluidAudio's ModelHub joins
// `repo.folderName` ("speaker-diarization" for the diarizer repo — confirmed
// against Sources/FluidAudio/ModelNames.swift) onto whatever directory is
// passed to `OfflineDiarizerModels.load(from:)`, so the 7 model files and
// the `.fluidaudio-revision` marker sit at `<modelsParentDir>/speaker-
// diarization/`, one level below this argument — not directly inside it.
let modelsParentDir = URL(fileURLWithPath: arguments[3])
let outputPath = arguments[4]

// Cosine-similarity cut-off for the host-echo check (SAA-194 §4) — a
// completely different quantity from the diarizer's own clustering
// threshold below, and never derived from it. From SAA-94 experiment C's
// cross-call similarity matrix: true (same-person) matches scored
// 0.83-0.96, wrong pairs at most 0.305. A host echo is the same voice
// recorded twice, so it should score in the true-match range — this sits
// with margin on both sides of that gap.
let hostEchoCosineThreshold: Float = 0.55

// Cosine-similarity cut-off for classifying a MIC-track diarized cluster as
// the host's own voice vs. bleed (SAA-199's "keep mic segments only where
// the host-reference match says Jon is speaking"). A different comparison
// from hostEchoCosineThreshold above — that one matches a whole TAP voice
// cluster against the host reference; this matches a whole MIC voice
// cluster against it — and not assumed to share its value.
//
// Calibrated from the only two clean-control mic clusters measured so far
// (09-14 sync, AirPods — bleed is not physically possible there): a real
// Jon cluster scored 0.918, and a non-speech noise cluster scored 0.510.
// The cut-off sits in the upper half of that gap rather than at its
// midpoint, because SAA-199's correct-or-absent rule makes a false keep
// (someone else's words landing under Jon's name) worse than a false drop
// (losing some of his own) — a cluster has to look confidently like Jon,
// not just more like Jon than not, to be classified host. Revisit once
// more clean-control data exists — this is two points, not a distribution.
let hostClusterCosineThreshold: Float = 0.75

// The diarizer's own clustering threshold — one of many OfflineDiarizerConfig
// parameters below, all set to fluidaudiocli's offline-mode defaults
// (ProcessCommand.swift's ParsedArgs), because this is the exact
// configuration SAA-94 experiment C validated against the Fathom answer
// keys. Coincidentally also 0.6, fluidaudiocli's own default — not derived
// from hostEchoCosineThreshold above, which measures something else
// entirely (voice-to-voice similarity, not segmentation/clustering).
let diarizationClusteringThreshold: Double = 0.6

// A diarized voice with less total speech than this is folded back onto
// `them` rather than becoming its own Voice N (SAA-194, addition/fix
// 2026-09-24 #2). Found empirically: the first 09-08 "4th voice" (7.3s)
// looked like host echo only because Fathom's start-only timestamps
// overlap whoever spoke during the host's own turns — a handful of short
// interjections from someone else, misread as "100% Jon." 15s is well
// above that scale (five ~1.5s interjections) while still comfortably
// below any real participant's contribution to a multi-minute call.
let minimumVoiceSeconds: Double = 15.0

// Clip selection for naming (SAA-195): up to this many clips per voice, each
// within this length range, single-voice only — no overlap with another
// surviving voice's speech, and no overlap with any mic-track speech at all
// (so the clip is never colored by the host also talking underneath it).
let maxClipsPerVoice = 3
let minClipSeconds: Double = 4.0
let maxClipSeconds: Double = 6.0

struct ClipRange: Codable {
    let start: Double
    let end: Double
}

struct VoiceOut: Codable {
    let voiceIndex: Int
    let sourceLabel: String  // FluidAudio's own "S1"/"S2"/... — kept for traceability only
    let totalSeconds: Double
    let embedding: [Float]
    let clipRanges: [ClipRange]
}

// voiceIndex is nil for a diarized segment that exists (FluidAudio found
// speech there) but was excluded from `voices` — either dropped as host
// echo or folded back for being under minimumVoiceSeconds. That's a
// different fact from "no diarized coverage here at all" (a true gap under
// a whisper segment), and the caller (pipeline/diarize.ts) needs to tell
// them apart: an excluded segment's time range must stay on `them`, not
// get swept into the nearest surviving voice by its gap-filling fallback.
struct SegmentOut: Codable {
    let start: Double
    let end: Double
    let voiceIndex: Int?
}

struct DiarizeSidecar: Codable {
    let model: String
    let modelRevision: String
    let clusteringThreshold: Double
    let hostEchoThreshold: Float
    let hostClusterThreshold: Float
    let processingTimeSeconds: Double
    let voices: [VoiceOut]
    let segments: [SegmentOut]
    let hostEchoSourceLabel: String?
    let hostEchoSimilarity: Float?
    // Time ranges on the MIC track classified as the host's own voice
    // (SAA-199), not bleed — every mic cluster scoring >= hostClusterThreshold
    // against the host reference embedding. Empty when no host reference
    // could be built at all (see below): with nothing to compare against,
    // nothing is claimed as host, which is the same drop-by-default posture
    // as everywhere else this ships.
    let hostVoiceRanges: [ClipRange]
    let error: String?
}

func writeSidecar(_ sidecar: DiarizeSidecar) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(sidecar) else {
        FileHandle.standardError.write("diarize: failed to encode sidecar\n".data(using: .utf8)!)
        return
    }
    try? data.write(to: URL(fileURLWithPath: outputPath))
}

func fail(_ message: String) -> Never {
    writeSidecar(
        DiarizeSidecar(
            model: "fluidaudio-community-1", modelRevision: "",
            clusteringThreshold: diarizationClusteringThreshold,
            hostEchoThreshold: hostEchoCosineThreshold, hostClusterThreshold: hostClusterCosineThreshold,
            processingTimeSeconds: 0, voices: [], segments: [],
            hostEchoSourceLabel: nil, hostEchoSimilarity: nil, hostVoiceRanges: [], error: message))
    FileHandle.standardError.write("diarize: \(message)\n".data(using: .utf8)!)
    exit(1)
}

// Duration-weighted mean embedding per FluidAudio speaker label — the same
// rule SAA-94's scratch scoring (embed_compare.py) used for the titanet and
// FluidAudio comparisons.
func meanEmbeddings(_ segments: [TimedSpeakerSegment]) -> [String: (embedding: [Float], totalSeconds: Double)]
{
    var sums: [String: [Float]] = [:]
    var weights: [String: Double] = [:]
    for seg in segments {
        let duration = Double(seg.durationSeconds)
        var sum = sums[seg.speakerId] ?? [Float](repeating: 0, count: seg.embedding.count)
        for i in 0..<min(sum.count, seg.embedding.count) {
            sum[i] += seg.embedding[i] * Float(duration)
        }
        sums[seg.speakerId] = sum
        weights[seg.speakerId, default: 0] += duration
    }
    var out: [String: (embedding: [Float], totalSeconds: Double)] = [:]
    for (label, sum) in sums {
        let weight = weights[label] ?? 1
        out[label] = (sum.map { $0 / Float(weight) }, weight)
    }
    return out
}

// Mono Float32 samples straight off disk, at the file's own sample rate —
// both tap and mic 16k wavs are already 16kHz mono by construction
// (transcribe.py's ffmpeg downsample), matching what the offline pipeline
// expects, so no resampling happens here.
func readMonoFloatSamples(_ url: URL) throws -> (samples: [Float], sampleRate: Double) {
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
        throw NSError(
            domain: "diarize", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "could not allocate a read buffer for \(url.path)"])
    }
    try file.read(into: buffer)
    guard let channelData = buffer.floatChannelData?[0] else {
        throw NSError(
            domain: "diarize", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "no float channel data after reading \(url.path)"])
    }
    return (Array(UnsafeBufferPointer(start: channelData, count: Int(buffer.frameLength))), format.sampleRate)
}

// Sorted, overlap-merged [start, end) intervals.
func mergeIntervals(_ intervals: [(Double, Double)]) -> [(Double, Double)] {
    guard !intervals.isEmpty else { return [] }
    let sorted = intervals.sorted { $0.0 < $1.0 }
    var merged = [sorted[0]]
    for (s, e) in sorted.dropFirst() {
        if s <= merged[merged.count - 1].1 {
            merged[merged.count - 1].1 = max(merged[merged.count - 1].1, e)
        } else {
            merged.append((s, e))
        }
    }
    return merged
}

// The complement of `intervals` within [0, duration) — the windows where
// none of `intervals` covers.
func complement(of intervals: [(Double, Double)], duration: Double) -> [(Double, Double)] {
    var gaps: [(Double, Double)] = []
    var cursor = 0.0
    for (s, e) in mergeIntervals(intervals) {
        if s > cursor { gaps.append((cursor, s)) }
        cursor = max(cursor, e)
    }
    if cursor < duration { gaps.append((cursor, duration)) }
    return gaps
}

func extractSamples(_ samples: [Float], sampleRate: Double, windows: [(Double, Double)]) -> [Float] {
    var out: [Float] = []
    for (s, e) in windows {
        let startIndex = max(0, Int(s * sampleRate))
        let endIndex = min(samples.count, Int(e * sampleRate))
        guard endIndex > startIndex else { continue }
        out.append(contentsOf: samples[startIndex..<endIndex])
    }
    return out
}

// A single embedding representing every voice found, combined rather than
// picking one (SAA-194, addition/fix 2026-09-24 #3): on audio that should
// be one speaker, any residual clustering fragmentation is blended back
// together by weighting each fragment's contribution by how much of the
// audio it actually covers, instead of gambling that the single largest
// fragment is the clean one — which is exactly what picked a wrong 715s
// mic-track cluster on 09-08 under the old "take the longest cluster" rule.
func combinedEmbedding(_ voices: [String: (embedding: [Float], totalSeconds: Double)]) -> [Float]? {
    guard let dim = voices.values.first?.embedding.count else { return nil }
    var sum = [Float](repeating: 0, count: dim)
    var weight = 0.0
    for (_, voice) in voices {
        for i in 0..<min(dim, voice.embedding.count) { sum[i] += voice.embedding[i] * Float(voice.totalSeconds) }
        weight += voice.totalSeconds
    }
    guard weight > 0 else { return nil }
    return sum.map { $0 / Float(weight) }
}

func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
    var dot: Float = 0
    var normA: Float = 0
    var normB: Float = 0
    for i in 0..<min(a.count, b.count) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }
    let denom = normA.squareRoot() * normB.squareRoot()
    return denom > 0 ? dot / denom : 0
}

// Subtract `others` (already sorted or not — doesn't matter) from a single
// [start, end) window, returning the pieces of it that survive.
func subtractIntervals(_ window: (Double, Double), _ others: [(Double, Double)]) -> [(Double, Double)] {
    var pieces = [window]
    for other in others {
        var next: [(Double, Double)] = []
        for (s, e) in pieces {
            let os = max(s, other.0)
            let oe = min(e, other.1)
            guard os < oe else {
                next.append((s, e))  // no overlap with this one
                continue
            }
            if s < os { next.append((s, os)) }
            if oe < e { next.append((oe, e)) }
        }
        pieces = next
    }
    return pieces
}

// Up to `maxClipsPerVoice` clean windows of `minClipSeconds`...`maxClipSeconds`
// for one voice: single-voice only (no overlap with any other surviving
// voice's segments) and no overlap with any mic-track speech at all
// (micSpeechRanges), longest clean stretch first (SAA-195).
//
// Consecutive segments of the SAME voice separated by a short gap are
// merged into one "run" first — otherwise a 2s segment right next to
// another 2.5s segment of the same voice, obviously one continuous turn,
// would each be too short to qualify alone.
func selectClips(
    ownSegments: [(Double, Double)],
    otherVoiceSegments: [(Double, Double)],
    micSpeechRanges: [(Double, Double)]
) -> [ClipRange] {
    let mergeGapSeconds = 0.5
    let sorted = ownSegments.sorted { $0.0 < $1.0 }
    var runs: [(Double, Double)] = []
    for (s, e) in sorted {
        if let last = runs.last, s - last.1 <= mergeGapSeconds {
            runs[runs.count - 1].1 = max(last.1, e)
        } else {
            runs.append((s, e))
        }
    }

    var candidates: [(clip: (Double, Double), cleanLength: Double)] = []
    for run in runs {
        for clean in subtractIntervals(run, otherVoiceSegments + micSpeechRanges) {
            let cleanLength = clean.1 - clean.0
            guard cleanLength >= minClipSeconds else { continue }
            let clipEnd = cleanLength > maxClipSeconds ? clean.0 + maxClipSeconds : clean.1
            candidates.append((clip: (clean.0, clipEnd), cleanLength: cleanLength))
        }
    }
    // Longest clean stretch first — ranked by the ORIGINAL clean length, not
    // the (possibly trimmed) clip length, so a 20s clean run outranks a
    // barely-4s one even though both get trimmed to at most 6s.
    candidates.sort { $0.cleanLength > $1.cleanLength }
    return candidates.prefix(maxClipsPerVoice).map { ClipRange(start: $0.clip.0, end: $0.clip.1) }
}

// What selectClips excludes mic time on, given this capture's host
// classification (SAA-199, 2026-09-29). hostVoiceRanges empty covers BOTH
// "no host reference could be built" and "a reference existed but no mic
// cluster reached hostClusterCosineThreshold" — the function can't tell
// those apart from its arguments alone, and doesn't need to: either way the
// answer is the same, fall back to excluding on every mic speech range
// (micSpeechRanges), the old, unrestricted behavior. That's the STRICTER
// fallback, not the looser one — an empty exclusion set would let a clip
// through with no mic-based check on it at all, worse than before this
// change, not equivalent to it. Only once at least one mic cluster clears
// the cut-off does the exclusion narrow to hostVoiceRanges alone.
func clipExclusionRanges(
    hostVoiceRanges: [ClipRange],
    micSpeechRanges: [(Double, Double)]
) -> [(Double, Double)] {
    hostVoiceRanges.isEmpty ? micSpeechRanges : hostVoiceRanges.map { ($0.start, $0.end) }
}

// No Task{}/DispatchSemaphore wrapper here — this file is literally
// main.swift, which Swift treats as an implicit async context at the top
// level (SE-0343), so `try await` works directly. An earlier version of
// this file used Task{} + semaphore.wait() to bridge into async from a
// synchronous top level; that's the wrong tool for a main.swift file
// specifically, and it deadlocked for real: semaphore.wait() blocks the
// only thread the cooperative thread pool has available, so the Task
// wrapping the actual work never got to run. Caught during SAA-194's own
// verification (fetch-models.sh hung indefinitely — near-zero CPU, no
// progress — rather than erroring or completing).
do {
    ModelHub.offlineMode = true

        let revisionMarker = modelsParentDir
            .appendingPathComponent("speaker-diarization")
            .appendingPathComponent(".fluidaudio-revision")
        let modelRevision =
            (try? String(contentsOf: revisionMarker, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"

        let configuration = MLModelConfigurationUtils.defaultConfiguration(computeUnits: .all)
        let models = try await OfflineDiarizerModels.load(
            from: modelsParentDir, configuration: configuration)

        // Every parameter here is fluidaudiocli's offline-mode default
        // (ProcessCommand.swift's ParsedArgs, offline section) — this is
        // deliberately the exact configuration SAA-94 experiment C ran and
        // validated against the Fathom answer keys, not a configuration we
        // chose. No `.withSpeakers(...)` call either: no speaker-count hint,
        // same as experiment C.
        let offlineConfig = OfflineDiarizerConfig(
            clusteringThreshold: diarizationClusteringThreshold,
            Fa: 0.07,
            Fb: 0.8,
            windowDuration: 10.0,
            sampleRate: 16_000,
            segmentationStepRatio: 0.2,
            embeddingBatchSize: 32,
            embeddingExcludeOverlap: true,
            embeddingSkipStrategy: .none,
            minSegmentDuration: 1.0,
            minGapDuration: 0.1,
            exclusiveSegments: true,
            speechOnsetThreshold: 0.5,
            speechOffsetThreshold: 0.5,
            segmentationMinDurationOn: 0.0,
            segmentationMinDurationOff: 0.0,
            maxVBxIterations: 20,
            convergenceTolerance: 1e-4,
            embeddingExportPath: nil
        )
        let manager = OfflineDiarizerManager(config: offlineConfig)
        manager.initialize(models: models)

        let start = Date()
        // No speaker-count hint on the tap track — SAA-194's whole point is
        // that it counts correctly unassisted (confirmed in experiment C).
        let tapResult = try await manager.process(URL(fileURLWithPath: tapPath))
        let processingTime = Date().timeIntervalSince(start)

        let tapVoices = meanEmbeddings(tapResult.segments)

        // Host reference embedding (SAA-194 §4, fixed 2026-09-24): built
        // ONLY from mic audio where the tap track has no diarized speech at
        // all — nobody on the call is talking, so anything on the mic there
        // is the host and only the host. This replaced diarizing the whole
        // mic track and taking its longest cluster, which on 09-08 picked a
        // 715s cluster out of 5 the mic track fragmented into — the mic
        // track is not reliably one clean cluster over a long call, so nor
        // was "the longest one" reliably the host.
        var hostEmbedding: [Float]? = nil
        if FileManager.default.fileExists(atPath: micPath) {
            let tapSpeechIntervals = tapResult.segments.map {
                (Double($0.startTimeSeconds), Double($0.endTimeSeconds))
            }
            let (micSamples, micSampleRate) = try readMonoFloatSamples(URL(fileURLWithPath: micPath))
            let micDuration = Double(micSamples.count) / micSampleRate
            let tapSilentWindows = complement(of: tapSpeechIntervals, duration: micDuration)
            let restrictedSamples = extractSamples(micSamples, sampleRate: micSampleRate, windows: tapSilentWindows)
            let restrictedSeconds = Double(restrictedSamples.count) / micSampleRate
            FileHandle.standardError.write(
                "diarize: host reference — \(tapSilentWindows.count) tap-silent window(s), \(String(format: "%.1f", restrictedSeconds))s of mic audio\n"
                    .data(using: .utf8)!)
            // Below this, whatever diarization says about it is noise, not a
            // usable host embedding — skip rather than guess.
            if restrictedSeconds >= 3.0 {
                let restrictedResult = try await manager.process(audio: restrictedSamples)
                let restrictedVoices = meanEmbeddings(restrictedResult.segments)
                FileHandle.standardError.write(
                    "diarize: host reference audio diarized into \(restrictedVoices.count) voice(s): "
                        .appending(restrictedVoices.map { "\($0.key)=\(String(format: "%.1f", $0.value.totalSeconds))s" }.joined(separator: ", "))
                        .appending("\n")
                        .data(using: .utf8)!)
                // Combined, not "take the longest" (see combinedEmbedding's
                // own comment) — the fix this whole block exists for.
                hostEmbedding = combinedEmbedding(restrictedVoices)
            } else {
                FileHandle.standardError.write(
                    "diarize: host reference — too little tap-silent mic audio, skipping host-echo check\n"
                        .data(using: .utf8)!)
            }
        }

        var hostEchoSourceLabel: String? = nil
        var hostEchoSimilarity: Float? = nil
        if let hostEmbedding {
            for (label, voice) in tapVoices {
                let similarity = cosineSimilarity(hostEmbedding, voice.embedding)
                FileHandle.standardError.write(
                    "diarize: host-echo check — tap voice \(label) vs host reference embedding: similarity=\(String(format: "%.3f", similarity))\n"
                        .data(using: .utf8)!)
                if similarity >= hostEchoCosineThreshold
                    && (hostEchoSimilarity == nil || similarity > hostEchoSimilarity!)
                {
                    hostEchoSourceLabel = label
                    hostEchoSimilarity = similarity
                }
            }
        }

        // Host-classified mic ranges (SAA-199, addition 2026-09-29): a full,
        // ordinary diarization of the whole mic track, same as before — but
        // now each resulting cluster's own mean embedding is kept and
        // compared against the host reference, instead of every segment
        // counting regardless of speaker. Used for two things downstream:
        // selectClips's exclusion set below (a clip is only ever colored by
        // the host's OWN voice underneath it, never by bleed, since clips
        // are cut from the tap file bleed never reaches), and SAA-199's own
        // mic-segment keep/drop filter (built downstream of this sidecar,
        // not here).
        //
        // Every cluster's score is logged when a host reference exists —
        // this is the whole measurement the threshold above was calibrated
        // against, and the next capture that needs recalibrating it depends
        // on having this trail.
        //
        // No host reference at all (hostEmbedding nil) means nothing CAN be
        // classified host — hostVoiceRanges (what the sidecar reports)
        // stays empty, absent evidence claims nothing. But clip selection
        // must not get looser just because the reference couldn't be built:
        // micSpeechRanges (the old, unfiltered "was anyone on mic at all"
        // list) is still computed every time and is what selectClips falls
        // back to excluding on whenever there's no host reference to narrow
        // it with — the same behavior this file had before this change.
        var micSpeechRanges: [(Double, Double)] = []
        var hostVoiceRanges: [ClipRange] = []
        if FileManager.default.fileExists(atPath: micPath) {
            let micResult = try await manager.process(URL(fileURLWithPath: micPath))
            micSpeechRanges = micResult.segments.map { (Double($0.startTimeSeconds), Double($0.endTimeSeconds)) }

            if let hostEmbedding {
                let micClusters = meanEmbeddings(micResult.segments)
                var segmentsByMicLabel: [String: [(Double, Double)]] = [:]
                for seg in micResult.segments {
                    segmentsByMicLabel[seg.speakerId, default: []].append(
                        (Double(seg.startTimeSeconds), Double(seg.endTimeSeconds)))
                }
                for (label, cluster) in micClusters {
                    let similarity = cosineSimilarity(hostEmbedding, cluster.embedding)
                    let isHost = similarity >= hostClusterCosineThreshold
                    FileHandle.standardError.write(
                        ("diarize: mic cluster \(label) — \(String(format: "%.1f", cluster.totalSeconds))s, " +
                            "similarity_to_host=\(String(format: "%.3f", similarity)), " +
                            "\(isHost ? "HOST" : "not-host")\n").data(using: .utf8)!)
                    if isHost {
                        for (s, e) in segmentsByMicLabel[label] ?? [] {
                            hostVoiceRanges.append(ClipRange(start: s, end: e))
                        }
                    }
                }
                hostVoiceRanges.sort { $0.start < $1.start }
                FileHandle.standardError.write(
                    ("diarize: host-classified mic ranges — \(hostVoiceRanges.count) segment(s), " +
                        "cut-off=\(hostClusterCosineThreshold)\n").data(using: .utf8)!)
            } else {
                FileHandle.standardError.write(
                    ("diarize: no host reference — no mic cluster classified as host; all mic speech will be " +
                        "dropped from the named transcript, and clip selection falls back to excluding on all " +
                        "mic speech (unchanged from before this change)\n").data(using: .utf8)!)
            }
        }
        // See clipExclusionRanges's own comment for what this falls back to
        // and why. Covered by `diarize --check-clip-exclusion`.
        let micRangesToExcludeFromClips = clipExclusionRanges(
            hostVoiceRanges: hostVoiceRanges, micSpeechRanges: micSpeechRanges)

        // A voice is excluded — folded back onto `them`, no Voice N of its
        // own — when it's the host echo, or when it falls under
        // minimumVoiceSeconds regardless of host-echo status. Both are
        // logged the same way: the distinction that matters downstream is
        // "real voice" vs "not," not which rule excluded it.
        var excludedReasons: [String: String] = [:]
        if let hostEchoSourceLabel {
            excludedReasons[hostEchoSourceLabel] = "host echo (similarity \(String(format: "%.3f", hostEchoSimilarity ?? 0)))"
        }
        for (label, voice) in tapVoices where voice.totalSeconds < minimumVoiceSeconds && excludedReasons[label] == nil {
            excludedReasons[label] = "under minimumVoiceSeconds (\(String(format: "%.1f", voice.totalSeconds))s < \(minimumVoiceSeconds)s)"
        }
        for (label, reason) in excludedReasons {
            FileHandle.standardError.write(
                "diarize: voice \(label) excluded — \(reason); its segments stay on `them`\n".data(using: .utf8)!)
        }

        // Stable, deterministic voiceIndex assignment (sorted by FluidAudio's
        // own label) for every surviving (non-excluded) voice.
        let survivingLabels = tapVoices.keys.filter { excludedReasons[$0] == nil }.sorted()
        var indexByLabel: [String: Int] = [:]
        for (i, label) in survivingLabels.enumerated() { indexByLabel[label] = i + 1 }

        var segmentsByLabel: [String: [(Double, Double)]] = [:]
        for seg in tapResult.segments {
            segmentsByLabel[seg.speakerId, default: []].append(
                (Double(seg.startTimeSeconds), Double(seg.endTimeSeconds)))
        }

        let voicesOut: [VoiceOut] = survivingLabels.map { label in
            let voice = tapVoices[label]!
            let ownSegments = segmentsByLabel[label] ?? []
            let otherSegments = survivingLabels
                .filter { $0 != label }
                .flatMap { segmentsByLabel[$0] ?? [] }
            let clipRanges = selectClips(
                ownSegments: ownSegments, otherVoiceSegments: otherSegments,
                micSpeechRanges: micRangesToExcludeFromClips)
            FileHandle.standardError.write(
                "diarize: voice \(label) — \(clipRanges.count) clip(s) selected for naming\n".data(using: .utf8)!)
            return VoiceOut(
                voiceIndex: indexByLabel[label]!, sourceLabel: label,
                totalSeconds: voice.totalSeconds, embedding: voice.embedding, clipRanges: clipRanges)
        }
        // Every diarized segment is emitted, including excluded voices' —
        // with voiceIndex nil for those, so the caller can tell "diarized
        // but excluded, leave on them" apart from "no diarized coverage at
        // all here" (a true gap, eligible for its own nearest-voice
        // fallback). See SegmentOut's own comment.
        let segmentsOut: [SegmentOut] = tapResult.segments.map { seg in
            SegmentOut(
                start: Double(seg.startTimeSeconds), end: Double(seg.endTimeSeconds),
                voiceIndex: indexByLabel[seg.speakerId])
        }

        writeSidecar(
            DiarizeSidecar(
                model: "fluidaudio-community-1",
                modelRevision: modelRevision,
                clusteringThreshold: diarizationClusteringThreshold,
                hostEchoThreshold: hostEchoCosineThreshold,
                hostClusterThreshold: hostClusterCosineThreshold,
                processingTimeSeconds: processingTime,
                voices: voicesOut,
                segments: segmentsOut,
                hostEchoSourceLabel: hostEchoSourceLabel,
                hostEchoSimilarity: hostEchoSimilarity,
                hostVoiceRanges: hostVoiceRanges,
                error: nil
            ))
} catch {
    fail("\(error)")
}
