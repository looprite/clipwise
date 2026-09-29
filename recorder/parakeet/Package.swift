// swift-tools-version: 6.0
import PackageDescription

// Same shape as ../diarize: a bare executable spawned by the pipeline
// (recorder/transcribe.py, SAA-220), not by main.js. Same FluidAudio pin as
// diarize (0.17.3, Package.resolved copied from it) — one version of the SDK
// across the recorder, so a bump is one decision, not two.
let package = Package(
    name: "parakeet",
    platforms: [.macOS("14.2")],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.3")
    ],
    targets: [
        .executableTarget(
            name: "parakeet",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
