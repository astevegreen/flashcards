// swift-tools-version: 5.9
import PackageDescription

// The package and product name must match what `cap sync` derives from the npm name
// `@flash/capacitor-secure-storage` ("FlashCapacitorSecureStorage").
let package = Package(
    name: "FlashCapacitorSecureStorage",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "FlashCapacitorSecureStorage",
            targets: ["FlashSecureStoragePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "FlashSecureStoragePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/FlashSecureStoragePlugin")
    ]
)
