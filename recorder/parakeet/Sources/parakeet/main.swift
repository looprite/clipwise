// Transcribes one 16 kHz mono WAV with Parakeet TDT 0.6B v2 through FluidAudio
// and writes the words with their start and end times (SAA-220, Architecture
// Decision 19). Spawned by recorder/transcribe.py, once per track. Lines are
// not built here: this is the "audio in, words out" half of the boundary, and
// transcribe.py owns the pause rule that turns words into lines.
//
// Usage: parakeet <models-dir> <input.16k.wav> <output.json>
//        parakeet --fetch-models <models-dir>
//
// No network, ever, on the run path. `ModelHub.offlineMode = true` is set
// before the models load, so a missing model directory throws instead of
// FluidAudio reaching Hugging Face. The models directory is populated ahead of
// time by fetch-models.sh, never by a run — same rule as ../diarize.
//
// The Core ML compile cache is written under ~/Library/Caches/<process name>/
// (measured in SAA-220's premise checks), so the first run on a machine costs
// about 12 s of model load and later runs about 0.14 s.

import FluidAudio
import Foundation

let arguments = CommandLine.arguments

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write("parakeet: \(message)\n".data(using: .utf8)!)
    exit(code)
}

// Maintenance-only, used by fetch-models.sh: the one place a network fetch is
// allowed. Files land directly in <models-dir>/parakeet-tdt-0.6b-v2/.
if arguments.count == 3, arguments[1] == "--fetch-models" {
    let target = URL(fileURLWithPath: arguments[2]).appendingPathComponent("parakeet-tdt-0.6b-v2")
    do {
        let dir = try await AsrModels.download(to: target, version: .v2)
        print("parakeet: fetched models into \(dir.path)")
        exit(0)
    } catch {
        fail("fetch failed: \(error)")
    }
}

#if arch(arm64)
#else
fail("skipped — Apple Silicon only, this Mac's arch is not arm64", code: 3)
#endif

guard arguments.count == 4 else {
    fail("usage: parakeet <models-dir> <input.16k.wav> <output.json>", code: 2)
}
let modelsDir = URL(fileURLWithPath: arguments[1]).appendingPathComponent("parakeet-tdt-0.6b-v2")
let inputURL = URL(fileURLWithPath: arguments[2])
let outputURL = URL(fileURLWithPath: arguments[3])

guard FileManager.default.fileExists(atPath: modelsDir.path) else {
    fail("no models at \(modelsDir.path) (run recorder/parakeet/fetch-models.sh)")
}

struct Word: Codable { let text: String; let start_ms: Int; let end_ms: Int }
struct Output: Codable {
    let engine: String
    let model: String
    let duration_s: Double
    let load_s: Double
    let transcribe_s: Double
    let words: [Word]
}

func now() -> Double { Date().timeIntervalSince1970 }

do {
    ModelHub.offlineMode = true
    let tLoad = now()
    let models = try await AsrModels.load(from: modelsDir, version: .v2)
    let manager = AsrManager(config: .default)
    try await manager.loadModels(models)
    let loadS = now() - tLoad

    let samples = try AudioConverter().resampleAudioFile(inputURL)
    var state = TdtDecoderState.make()
    let tRun = now()
    let result = try await manager.transcribe(samples, decoderState: &state)
    let runS = now() - tRun

    // Tokens to words. FluidAudio's tokenTimings carry the SentencePiece word
    // boundary as a leading space (or U+2581); the first token always opens a
    // word. Same rule the SAA-219 scorer applied to these tokens.
    struct Building { var text: String; var start: Double; var end: Double }
    var built: [Building] = []
    for t in result.tokenTimings ?? [] {
        let opens = built.isEmpty || t.token.hasPrefix(" ") || t.token.hasPrefix("\u{2581}")
        let piece = t.token.replacingOccurrences(of: "\u{2581}", with: "")
        if opens {
            built.append(Building(text: piece.trimmingCharacters(in: .whitespaces), start: t.startTime, end: t.endTime))
        } else {
            built[built.count - 1].text += piece
            built[built.count - 1].end = t.endTime
        }
    }
    let words = built.map {
        Word(text: $0.text, start_ms: Int(($0.start * 1000).rounded()), end_ms: Int(($0.end * 1000).rounded()))
    }

    let out = Output(
        engine: "parakeet", model: "parakeet-tdt-0.6b-v2",
        duration_s: Double(samples.count) / 16000, load_s: loadS, transcribe_s: runS, words: words)
    try JSONEncoder().encode(out).write(to: outputURL)
    print("parakeet: \(words.count) words, audio \(out.duration_s)s, load \(loadS)s, transcribe \(runS)s")
} catch {
    fail("\(error)")
}
