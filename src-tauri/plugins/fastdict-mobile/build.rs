fn main() {
    // Only the application commands expose this bridge to the bundled main UI.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
