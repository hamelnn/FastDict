fn main() {
    // Register every application command so unlisted local WebViews are denied
    // by Tauri's ACL before command argument handling or OS work begins.
    let app = tauri_build::AppManifest::new().commands(&[
        "show_sidebar", "expand_window", "hide_window", "read_clipboard", "write_clipboard",
        "start_capture", "get_capture", "finish_capture", "cancel_capture",
        "capture_overlay_ready", "capture_ready", "recover_capture", "capture_boot_error", "frontend_ready", "report_boot_error", "quit_app",
        "get_screen_permission", "request_screen_permission", "open_screen_permission_settings",
        "configure_shortcuts", "get_shortcut_status", "get_desktop_preferences", "set_desktop_preferences",
        "get_chatgpt_status", "sign_in_chatgpt", "cancel_chatgpt_sign_in", "disconnect_chatgpt",
        "open_chatgpt_usage", "select_chatgpt_profile", "forget_chatgpt_profile",
        "translate_with_chatgpt", "cancel_chatgpt_translation", "save_api_key", "get_api_key", "delete_api_key",
        "mobile_pick_image", "mobile_share_text",
    ]);
    let mut attributes = tauri_build::Attributes::new().app_manifest(app);
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri's normal resource is linked only to application binaries. Unit
        // tests using MockRuntime also import Common Controls v6 functions, so
        // their EXE needs the activation manifest before Windows loads it.
        // Compile the manifest once for every artifact (MSVC and GNU), while
        // keeping Tauri's version/icon resource free of a duplicate manifest.
        // https://github.com/tauri-apps/tauri/issues/13419
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        );
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.rc");
        embed_resource::compile_for_everything("windows-app-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("embed Common Controls v6 activation manifest");
    }
    tauri_build::try_build(attributes).expect("build application ACL");
}
