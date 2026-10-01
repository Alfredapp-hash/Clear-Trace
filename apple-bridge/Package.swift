// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ClearTraceAppleBridge",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "cleartrace-apple-bridge",
            path: "Sources/AppleBridge",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "AppleBridgeTests",
            dependencies: ["cleartrace-apple-bridge"],
            path: "Tests/AppleBridgeTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
