// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "VibeFusionKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "VFCore", targets: ["VFCore"]),
        .library(name: "VFAudio", targets: ["VFAudio"]),
        .library(name: "VFDesignSystem", targets: ["VFDesignSystem"]),
    ],
    targets: [
        .target(name: "VFCore", path: "Sources/VFCore"),
        .target(name: "VFAudio", dependencies: ["VFCore"], path: "Sources/VFAudio"),
        .target(name: "VFDesignSystem", dependencies: ["VFCore"], path: "Sources/VFDesignSystem"),
        .testTarget(name: "VFCoreTests", dependencies: ["VFCore"], path: "Tests/VFCoreTests"),
        .testTarget(name: "VFAudioTests", dependencies: ["VFAudio", "VFCore"], path: "Tests/VFAudioTests"),
    ]
)
