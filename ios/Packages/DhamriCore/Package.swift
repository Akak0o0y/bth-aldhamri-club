// swift-tools-version:5.9
// Everything the app and the broadcast extension share that needs nothing but
// Foundation: endpoints, the SDP edits the browser publisher makes, the WHIP
// and accounts HTTP calls, the relay's hold messages, audio mixing and frame
// sizing. It builds and tests on macOS and Linux (`swift test`), so most of the
// protocol logic is checked without a device.
import PackageDescription

let package = Package(
    name: "DhamriCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "DhamriCore", targets: ["DhamriCore"]),
    ],
    targets: [
        .target(name: "DhamriCore"),
        .testTarget(name: "DhamriCoreTests", dependencies: ["DhamriCore"]),
    ]
)
