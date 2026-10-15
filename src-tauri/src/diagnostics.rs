//! Boot diagnostics contain fixed stage labels only, never source text or keys.
use std::{fs::{self, OpenOptions}, io::Write, sync::{Mutex, atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct DiagnosticsState {
    generation: AtomicU64,
    ready: AtomicBool,
    recoveries: AtomicUsize,
    alerted: AtomicBool,
    writer: Mutex<()>,
}

const SAFE_STAGES: &[&str] = &[
    "bootstrap-start", "bootstrap-import-failed", "react-render-failed",
    "storage-read-failed", "storage-write-failed", "unhandled-error",
    "unhandled-rejection", "bootstrap-timeout",
];

pub fn record(app: &AppHandle, stage: &str) {
    // Keep the fixed stage available even when log directories are unavailable;
    // diagnostic output itself must never panic if a parent closes stderr.
    let _ = writeln!(std::io::stderr(), "FastDict: {stage}");
    let Some(state) = app.try_state::<DiagnosticsState>() else { return; };
    let Ok(_guard) = state.writer.lock() else { return; };
    let Ok(directory) = app.path().app_log_dir() else { return; };
    if fs::create_dir_all(&directory).is_err() { return; }
    let path = directory.join("startup.log");
    if fs::metadata(&path).map(|metadata| metadata.len() > 262_144).unwrap_or(false) {
        let previous = directory.join("startup.previous.log");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&path, previous);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let _ = writeln!(file, "{timestamp} version={} stage={stage}", env!("CARGO_PKG_VERSION"));
    }
}

pub fn report(app: &AppHandle, stage: &str) -> Result<(), String> {
    if !SAFE_STAGES.contains(&stage) { return Err("诊断阶段无效".into()); }
    record(app, stage);
    if matches!(stage, "bootstrap-import-failed" | "react-render-failed" | "unhandled-error" | "unhandled-rejection" | "bootstrap-timeout") {
        // Storage warnings and bootstrap-start never interrupt the application.
        failure(app, "frontend-load-failed", false);
    }
    Ok(())
}

pub fn main_ready(app: &AppHandle) {
    if let Some(state) = app.try_state::<DiagnosticsState>() {
        state.ready.store(true, Ordering::SeqCst);
    }
    record(app, "main-frontend-ready");
}

pub fn page_loading(app: &AppHandle, label: &str) {
    if label != "main" {
        if label == "capture" { record(app, "capture-page-started"); }
        return;
    }
    let Some(state) = app.try_state::<DiagnosticsState>() else { return; };
    state.ready.store(false, Ordering::SeqCst);
    mark_frontend_failed(app);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    record(app, "main-page-started");
    #[cfg(desktop)]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(12)).await;
            let expired = app.try_state::<DiagnosticsState>().map(|state| {
                state.generation.load(Ordering::SeqCst) == generation && !state.ready.load(Ordering::SeqCst)
            }).unwrap_or(false);
            if expired { failure(&app, "main-ready-timeout", true); }
        });
    }
    #[cfg(mobile)]
    let _ = generation;
}

pub fn page_finished(app: &AppHandle, label: &str) {
    match label {
        "main" => record(app, "main-page-finished"),
        "capture" => record(app, "capture-page-finished"),
        _ => {},
    }
}

pub fn initialize(app: &AppHandle) {
    record(app, "native-setup");
    // Also arm a watchdog if the renderer fails before a page-load event arrives.
    page_loading(app, "main");
    #[cfg(target_os = "windows")]
    install_process_monitor(app);
}

fn failure(app: &AppHandle, stage: &str, recover: bool) {
    mark_frontend_failed(app);
    record(app, stage);
    let Some(state) = app.try_state::<DiagnosticsState>() else { return; };
    if recover && state.recoveries.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        record(app, "native-reload-attempt");
        page_loading(app, "main");
        #[cfg(target_os = "windows")]
        if let Some(window) = app.get_webview_window("main") {
            let reload_app = app.clone();
            if window.with_webview(move |platform| {
                let success = unsafe { platform.controller().CoreWebView2().and_then(|view| view.Reload()) }.is_ok();
                if !success { failure(&reload_app, "native-reload-failed", false); }
            }).is_ok() { return; }
        }
        #[cfg(not(target_os = "windows"))]
        if let Some(window) = app.get_webview_window("main") {
            if window.eval("location.reload()").is_ok() { return; }
        }
    }
    if state.alerted.swap(true, Ordering::SeqCst) { return; }
    record(app, "native-fallback-requested");
    let path = app.path().app_log_dir().ok().map(|path| path.join("startup.log").display().to_string()).unwrap_or_default();
    #[cfg(target_os = "macos")]
    let exit_instruction = "你可以关闭主窗口，使用菜单「退出 FastDict」，或按 Command + Q / Option + Command + Q 退出，然后重新打开应用。";
    #[cfg(not(target_os = "macos"))]
    let exit_instruction = "你可以关闭主窗口，或按 Ctrl + Alt + Q 立即退出，然后重新打开应用。";
    let message = format!("轻译界面未能完成加载。\n\n{exit_instruction}\n\n诊断日志：\n{path}");
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let shown = native_message(&app, &message);
        record(&app, if shown { "native-fallback-completed" } else { "native-fallback-unavailable" });
    });
}

fn mark_frontend_failed(app: &AppHandle) {
    #[cfg(desktop)]
    if let Some(state) = app.try_state::<crate::desktop::DesktopState>() {
        state.frontend_ready.store(false, Ordering::SeqCst);
    }
    #[cfg(mobile)]
    let _ = app;
}

#[cfg(target_os = "windows")]
fn install_process_monitor(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let monitor_app = app.clone();
        let result = window.with_webview(move |platform| unsafe {
            if let Ok(view) = platform.controller().CoreWebView2() {
                let mut token = 0;
                let callback_app = monitor_app.clone();
                let handler = webview2_com::ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    let mut kind = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND(0);
                    if let Some(args) = args { let _ = args.ProcessFailedKind(&mut kind); }
                    let stage = match kind.0 {
                        0 => "webview-browser-exited",
                        1 => "webview-renderer-exited",
                        2 => "webview-renderer-unresponsive",
                        3 => "webview-frame-renderer-exited",
                        6 => "webview-gpu-exited",
                        _ => "webview-other-process-failed",
                    };
                    record(&callback_app, stage);
                    if kind.0 == 0 || kind.0 == 1 || kind.0 == 2 {
                        let failed_app = callback_app.clone();
                        tauri::async_runtime::spawn(async move { failure(&failed_app, stage, true); });
                    }
                    // WebView2 restarts its GPU process automatically; keep the
                    // diagnostic without disabling hardware acceleration.
                    Ok(())
                }));
                if view.add_ProcessFailed(&handler, &mut token).is_err() { record(&monitor_app, "process-monitor-install-failed"); }
            }
        });
        if result.is_err() { record(app, "process-monitor-install-failed"); }
    }
}

#[cfg(target_os = "windows")]
fn native_message(_app: &AppHandle, message: &str) -> bool {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(owner: *mut c_void, text: *const u16, title: *const u16, flags: u32) -> i32;
    }
    let text: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "FastDict · 轻译启动提示".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10) != 0 }
}

#[cfg(target_os = "macos")]
fn native_message(app: &AppHandle, message: &str) -> bool {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(allocator: *const c_void, bytes: *const u8, length: isize, encoding: u32, external: u8) -> *const c_void;
        fn CFRelease(value: *const c_void);
        fn CFUserNotificationDisplayAlert(timeout: f64, flags: usize, icon: *const c_void, sound: *const c_void,
            localization: *const c_void, header: *const c_void, message: *const c_void, default_button: *const c_void,
            alternate_button: *const c_void, other_button: *const c_void, response: *mut usize) -> i32;
    }
    unsafe {
        let strings: Vec<*const c_void> = ["FastDict · 轻译启动提示", message, "退出应用", "保留窗口"].iter()
            .map(|text| CFStringCreateWithBytes(std::ptr::null(), text.as_ptr(), text.len() as isize, 0x0800_0100, 0)).collect();
        if strings.iter().any(|value| value.is_null()) {
            for value in strings { if !value.is_null() { CFRelease(value); } }
            return false;
        }
        let mut response = 0;
        // CoreFoundation presents a console alert independently of WKWebView.
        // Waiting runs on a worker; the native menu and exit shortcut stay live.
        let result = CFUserNotificationDisplayAlert(0.0, 2, std::ptr::null(), std::ptr::null(), std::ptr::null(),
            strings[0], strings[1], strings[2], strings[3], std::ptr::null(), &mut response);
        for value in strings { CFRelease(value); }
        if result == 0 && response & 3 == 0 { app.exit(0); }
        result == 0
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn native_message(_app: &AppHandle, _message: &str) -> bool { false }
