// swift-tools-version:5.9
import PackageDescription

// The macOS app: a native window around `narrowbit ui`. Built with plain SwiftPM (no Xcode
// project needed) by scripts/build-mac-app.sh, which also wraps the binary into Narrowbit.app.
let package = Package(
    name: "Narrowbit",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "Narrowbit", path: "Sources/Narrowbit"),
    ]
)
