//! Command authorization is checked before dispatching OS or credential work.
use tauri::{Runtime, WebviewWindow};

pub fn require_main_label(label: &str) -> Result<(), String> {
    if label == "main" { Ok(()) } else { Err("此操作仅允许在主窗口执行".into()) }
}

pub fn require_main<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    require_main_label(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::{Manager, State};
    #[derive(Default)]
    struct SyntheticOs { touched: AtomicUsize }
    fn touch(state: State<SyntheticOs>) -> usize { state.touched.fetch_add(1, Ordering::SeqCst) + 1 }
    #[tauri::command]
    fn get_api_key(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn save_api_key(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn delete_api_key(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn read_clipboard(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn write_clipboard(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn configure_shortcuts(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn quit_app(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn forget_chatgpt_profile(state: State<SyntheticOs>) -> usize { touch(state) }
    #[tauri::command]
    fn get_capture() -> usize { 42 }
    #[tauri::command]
    fn recover_capture() -> usize { 42 }
    #[tauri::command]
    fn capture_boot_error() -> usize { 42 }

    #[test]
    fn runtime_acl_denies_capture_secrets_os_commands_and_event_emission_before_dispatch() {
        use tauri::{ipc::{CallbackFn, InvokeBody}, test::{get_ipc_response, mock_builder, INVOKE_KEY}, webview::InvokeRequest};
        // Keep the real application ACL, but avoid a second macOS Info.plist
        // symbol in the test binary alongside the production context in run().
        let app = mock_builder().manage(SyntheticOs::default()).invoke_handler(tauri::generate_handler![
            get_api_key, save_api_key, delete_api_key, read_clipboard, write_clipboard, configure_shortcuts, quit_app, forget_chatgpt_profile,
            get_capture, recover_capture, capture_boot_error,
        ]).build(tauri::generate_context!(test = true)).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let capture = tauri::WebviewWindowBuilder::new(&app, "capture", Default::default()).build().unwrap();
        let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
        let invoke = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, body: serde_json::Value| {
            get_ipc_response(window, InvokeRequest { cmd:command.into(), callback:CallbackFn(0), error:CallbackFn(1),
                url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
                body:InvokeBody::Json(body), headers:Default::default(), invoke_key:INVOKE_KEY.into() })
        };
        for command in ["get_api_key", "save_api_key", "delete_api_key", "read_clipboard", "write_clipboard", "configure_shortcuts", "quit_app", "forget_chatgpt_profile"] {
            assert!(invoke(&capture, command, serde_json::json!({})).is_err(), "capture allowed {command}");
            assert!(invoke(&other, command, serde_json::json!({})).is_err(), "unknown window allowed {command}");
        }
        assert_eq!(app.state::<SyntheticOs>().touched.load(Ordering::SeqCst),0);
        assert!(invoke(&main, "get_api_key", serde_json::json!({})).is_ok());
        assert_eq!(app.state::<SyntheticOs>().touched.load(Ordering::SeqCst),1);
        assert_eq!(invoke(&capture, "get_capture", serde_json::json!({})).unwrap().deserialize::<usize>().unwrap(),42);
        assert!(invoke(&main, "get_capture", serde_json::json!({})).is_err());
        for command in ["recover_capture", "capture_boot_error"] {
            assert!(invoke(&capture, command, serde_json::json!({})).is_ok());
            assert!(invoke(&main, command, serde_json::json!({})).is_err());
            assert!(invoke(&other, command, serde_json::json!({})).is_err());
        }
        for window in [&capture,&main] {
            for command in ["plugin:event|emit", "plugin:event|emit_to"] {
                assert!(invoke(window,command,serde_json::json!({"event":"fastdict://clipboard","payload":"synthetic","target":{"kind":"Any"}})).is_err());
            }
            let id = invoke(window,"plugin:event|listen",serde_json::json!({"event":"fastdict://capture-start","target":{"kind":"Any"},"handler":7})).unwrap().deserialize::<u32>().unwrap();
            assert!(invoke(window,"plugin:event|unlisten",serde_json::json!({"event":"fastdict://capture-start","eventId":id})).is_ok());
        }
    }
    #[test]
    fn only_the_main_window_can_dispatch_privileged_work() {
        assert!(require_main_label("main").is_ok());
        for label in ["capture", "other", "", "Main", "main-child"] {
            assert!(require_main_label(label).is_err());
        }
    }
}
