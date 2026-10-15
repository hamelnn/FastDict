// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-fastdict-mobile",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-fastdict-mobile", type: .static, targets: ["tauri-plugin-fastdict-mobile"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-fastdict-mobile", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
