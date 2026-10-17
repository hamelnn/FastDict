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
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app)).expect("build application ACL");
}
