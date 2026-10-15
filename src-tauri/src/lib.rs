mod secrets;
mod diagnostics;
mod macos;
mod mobile;
mod desktop_preferences;
#[cfg(desktop)]
mod capture;
#[cfg(desktop)]
mod macos_capture;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreview {
    #[serde(flatten)]
    pub screenshot: Screenshot,
    pub session_id: u64,
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
    use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder};
    #[cfg(not(target_os = "macos"))]
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    #[cfg(target_os = "macos")]
    pub const CAPTURE_SHORTCUT: &str = "Command+Alt+S";
    #[cfg(not(target_os = "macos"))]
    pub const CAPTURE_SHORTCUT: &str = "CommandOrControl+Shift+S";
    #[cfg(target_os = "macos")]
    pub const CLIPBOARD_SHORTCUT: &str = "Command+Alt+V";
    #[cfg(not(target_os = "macos"))]
    pub const CLIPBOARD_SHORTCUT: &str = "CommandOrControl+Shift+D";
    #[cfg(target_os = "macos")]
    pub const QUIT_SHORTCUT: &str = "Command+Alt+Q";
    #[cfg(not(target_os = "macos"))]
    pub const QUIT_SHORTCUT: &str = "Control+Alt+Q";

    pub fn quit_reserved_message() -> String {
        #[cfg(target_os = "macos")]
        { "Option + Command + Q 保留用于立即退出".into() }
        #[cfg(not(target_os = "macos"))]
        { "Ctrl + Alt + Q 保留用于立即退出".into() }
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShortcutStatus {
        pub capture_shortcut: String,
        pub clipboard_shortcut: String,
        pub error: Option<String>,
    }

    pub struct DesktopState {
        pub tray_ready: AtomicBool,
        pub frontend_ready: AtomicBool,
        pub preferences_pending: AtomicBool,
        pub shortcuts: Mutex<ShortcutStatus>,
        pub shortcut_configuration: Mutex<()>,
    }

    impl Default for DesktopState {
        fn default() -> Self {
            Self {
                tray_ready: AtomicBool::new(false),
                frontend_ready: AtomicBool::new(false),
                preferences_pending: AtomicBool::new(false),
                shortcut_configuration: Mutex::new(()),
                shortcuts: Mutex::new(ShortcutStatus {
                    capture_shortcut: CAPTURE_SHORTCUT.into(),
                    clipboard_shortcut: CLIPBOARD_SHORTCUT.into(),
                    error: None,
                }),
            }
        }
    }

    pub fn register(app: &AppHandle, screenshot: &str, clipboard: &str) -> Result<(), String> {
        let screenshot_key: Shortcut = screenshot.parse().map_err(|error| format!("截图快捷键无效：{error}"))?;
        let clipboard_key: Shortcut = clipboard.parse().map_err(|error| format!("复制快捷键无效：{error}"))?;
        if screenshot_key == clipboard_key { return Err("两项快捷键不能相同".into()); }
        let quit_key: Shortcut = QUIT_SHORTCUT.parse().map_err(|_| "退出快捷键无效")?;
        if screenshot_key == quit_key || clipboard_key == quit_key { return Err(quit_reserved_message()); }

        let screenshot_result = app.global_shortcut().on_shortcut(screenshot_key, |app, _, event| {
            if event.state != ShortcutState::Pressed || capture::is_active(app) { return; }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = capture::begin(app.clone()).await {
                    if !capture::is_active(&app) { report_error(&app, error); }
                }
            });
        }).map_err(|error| format!("无法注册截图快捷键，可能已被其他程序占用：{error}"));
        let clipboard_result = app.global_shortcut().on_shortcut(clipboard_key, |app, _, event| {
            if event.state != ShortcutState::Pressed || capture::is_active(app) { return; }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Show first; clipboard IPC runs on a worker without delaying the panel.
                if show_sidebar_impl(&app).is_err() { return; }
                match read_clipboard(app.clone()).await {
                    Ok(text) if !text.trim().is_empty() => { let _ = app.emit_to("main", "fastdict://clipboard", text); }
                    Ok(_) => report_error(&app, "剪贴板没有文本，请先复制要翻译的内容".into()),
                    Err(error) => report_error(&app, error),
                }
            });
        }).map_err(|error| format!("无法注册复制快捷键，可能已被其他程序占用：{error}"));
        // Keep a working screenshot binding even when only the clipboard key is occupied.
        let errors: Vec<String> = [screenshot_result, clipboard_result].into_iter().filter_map(Result::err).collect();
        if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
    }

    pub fn report_error(app: &AppHandle, message: String) {
        if show_sidebar_impl(app).is_ok() {
            let _ = app.emit_to("main", "fastdict://error", message);
        }
    }

    pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        desktop_preferences::initialize(app.handle());
        diagnostics::initialize(app.handle());
        #[cfg(target_os = "macos")]
        app.set_menu(macos::application_menu(app.handle())?)?;
        register_quit(app.handle());
        if let Err(error) = capture::preload(app.handle()) {
            eprintln!("截图窗口初始化失败：{error}");
        }
        if let Err(error) = register(app.handle(), CAPTURE_SHORTCUT, CLIPBOARD_SHORTCUT) {
            eprintln!("{error}");
            if let Ok(mut status) = app.state::<DesktopState>().shortcuts.lock() { status.error = Some(error); }
        }

        let show = MenuItem::with_id(app, "show", "展开主窗口", true, None::<&str>)?;
        let screenshot = MenuItem::with_id(app, "capture", "截图翻译", true, None::<&str>)?;
        let sidebar = MenuItem::with_id(app, "sidebar", "打开翻译侧栏", true, None::<&str>)?;
        let preferences = MenuItem::with_id(app, "preferences", "设置…", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出 FastLingo", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&screenshot, &show, &sidebar, &preferences, &quit])?;
        let mut tray = TrayIconBuilder::with_id("fastdict")
            .menu(&menu)
            .tooltip("FastLingo · 截图与剪贴板翻译")
            .show_menu_on_left_click(cfg!(target_os = "macos"))
            .on_tray_icon_event(|tray, event| {
                #[cfg(not(target_os = "macos"))]
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    let _ = show_sidebar_impl(tray.app_handle());
                }
                #[cfg(target_os = "macos")]
                let _ = (tray, event);
            });
        #[cfg(target_os = "macos")]
        { tray = tray.icon(macos::menu_bar_icon()).icon_as_template(true); }
        #[cfg(not(target_os = "macos"))]
        if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
        match tray.build(app) {
            Ok(_) => app.state::<DesktopState>().tray_ready.store(true, Ordering::SeqCst),
            Err(error) => eprintln!("系统托盘不可用：{error}"),
        }
        Ok(())
    }

    pub fn show_preferences(app: &AppHandle) {
        if capture::is_active(app) && capture::cancel_window(app).is_err() { return; }
        if expand_window_impl(app).is_err() { return; }
        let state = app.state::<DesktopState>();
        if state.frontend_ready.load(Ordering::SeqCst) {
            let _ = app.emit_to("main", "fastdict://navigate", "settings");
        } else {
            state.preferences_pending.store(true, Ordering::SeqCst);
        }
    }

    pub fn menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
        match event.id.as_ref() {
            "show" => {
                if !capture::restore_visible(app) { let _ = expand_window_impl(app); }
            }
            "capture" => {
                if !capture::is_active(app) {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = capture::begin(app.clone()).await {
                            if !capture::is_active(&app) { report_error(&app, error); }
                        }
                    });
                }
            }
            "sidebar" => { let _ = show_sidebar_impl(app); }
            "preferences" => show_preferences(app),
            "quit" => app.exit(0),
            _ => {},
        }
    }

    pub fn register_quit(app: &AppHandle) {
        if app.global_shortcut().is_registered(QUIT_SHORTCUT) { return; }
        if app.global_shortcut().on_shortcut(QUIT_SHORTCUT, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                app.exit(0);
            }
        }).is_err() { diagnostics::record(app, "quit-shortcut-register-failed"); }
    }
}

pub(crate) fn show_sidebar_impl(app: &AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    if capture::is_active(app) { return Err("请先完成当前截图".into()); }
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    #[cfg(target_os = "macos")]
    app.show().map_err(|error| error.to_string())?;
    #[cfg(desktop)]
    {
        #[cfg(target_os = "macos")]
        let monitor_at_cursor = macos::cursor_point()
            .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten());
        #[cfg(not(target_os = "macos"))]
        let monitor_at_cursor = window.cursor_position().ok()
            .and_then(|point| window.monitor_from_point(point.x, point.y).ok().flatten());
        let monitor = monitor_at_cursor
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        window.unmaximize().map_err(|error| error.to_string())?;
        if let Some(monitor) = monitor {
            let area = monitor.work_area();
            #[cfg(target_os = "macos")]
            {
                // Tao converts physical positions using the window's *current*
                // scale. Quartz logical coordinates avoid a wrong placement when
                // moving from a Retina display to a non-Retina external monitor.
                let scale = monitor.scale_factor();
                let width = 440.0_f64.min((area.size.width as f64 / scale - 32.0).max(1.0));
                // set_size controls the content area; account for the standard
                // titlebar so the whole sidebar stays inside the work area.
                let titlebar_height = window.outer_size().ok().zip(window.inner_size().ok())
                    .map(|(outer, inner)| outer.height.saturating_sub(inner.height) as f64
                        / window.scale_factor().unwrap_or(scale)).unwrap_or(28.0);
                let height = (area.size.height as f64 / scale - 32.0 - titlebar_height).max(1.0);
                window.set_position(tauri::LogicalPosition::new(
                    (area.position.x as f64 + area.size.width as f64) / scale - width - 16.0,
                    area.position.y as f64 / scale + 16.0,
                )).map_err(|error| error.to_string())?;
                window.set_size(tauri::LogicalSize::new(width, height)).map_err(|error| error.to_string())?;
            }
            #[cfg(not(target_os = "macos"))]
            {
            let margin = (16.0 * monitor.scale_factor()).round() as u32;
            let width = (440.0 * monitor.scale_factor()).round() as u32;
            let width = width.min(area.size.width.saturating_sub(2 * margin)).max(1);
            let height = area.size.height.saturating_sub(2 * margin).max(1);
            // Move before sizing so Windows applies the destination monitor's
            // DPI transition before the final physical dimensions.
            window.set_position(tauri::PhysicalPosition::new(
                area.position.x + area.size.width as i32 - width as i32 - margin as i32,
                area.position.y + margin as i32,
            )).map_err(|error| error.to_string())?;
            window.set_size(tauri::PhysicalSize::new(width, height)).map_err(|error| error.to_string())?;
            }
        } else {
            window.set_size(tauri::LogicalSize::new(440.0, 740.0)).map_err(|error| error.to_string())?;
        }
        window.set_always_on_top(true).map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
    }
    app.emit_to("main", "fastdict://mode", "sidebar").map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn expand_window_impl(app: &AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    if capture::is_active(app) { return Err("请先完成当前截图".into()); }
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    #[cfg(target_os = "macos")]
    app.show().map_err(|error| error.to_string())?;
    #[cfg(desktop)]
    {
        window.set_always_on_top(false).map_err(|error| error.to_string())?;
        window.unmaximize().map_err(|error| error.to_string())?;
        window.set_size(tauri::LogicalSize::new(1120.0, 780.0)).map_err(|error| error.to_string())?;
        window.center().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
    }
    app.emit_to("main", "fastdict://mode", "expanded").map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_sidebar(app: AppHandle) -> Result<(), String> { show_sidebar_impl(&app) }

#[tauri::command]
fn expand_window(app: AppHandle) -> Result<(), String> { expand_window_impl(&app) }

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if !app.state::<desktop::DesktopState>().tray_ready.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("系统托盘暂不可用，请保留主窗口".into());
        }
        if let Some(window) = app.get_webview_window("main") { window.hide().map_err(|error| error.to_string())?; }
    }
    Ok(())
}

#[tauri::command]
fn get_screen_permission() -> macos::ScreenPermission { macos::screen_permission() }

#[tauri::command]
async fn request_screen_permission(app: AppHandle, window: tauri::WebviewWindow) -> Result<macos::ScreenPermission, String> {
    if window.label() != "main" { return Err("请在主窗口设置中申请屏幕录制权限".into()); }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(macos::request_screen_permission());
        }).map_err(|_| "暂时无法显示系统权限提示")?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|_| "系统权限提示未完成".to_string()))
            .await.map_err(|_| "系统权限提示未完成".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Ok(macos::screen_permission()) }
}

#[tauri::command]
async fn open_screen_permission_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("请在主窗口设置中打开系统权限设置".into()); }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let result = std::process::Command::new("/usr/bin/open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                .status().map_err(|_| "无法打开系统设置，请手动前往隐私与安全性 → 屏幕录制".to_string())?;
            if result.success() { Ok(()) } else { Err("无法打开系统设置，请手动前往隐私与安全性 → 屏幕录制".into()) }
        }).await.map_err(|_| "无法打开系统设置".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    { Err("此系统无需申请 macOS 屏幕录制权限".into()) }
}

#[tauri::command]
async fn read_clipboard(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard().read_text().map_err(|error| format!("无法读取剪贴板：{error}"))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn write_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard().write_text(text).map_err(|error| format!("无法写入剪贴板：{error}"))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn start_capture(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("请先完成当前截图".into()); }
    #[cfg(desktop)]
    { capture::begin(app).await }
    #[cfg(mobile)]
    { let _ = app; Err("移动端请从相册选择截图，或复制文字后粘贴翻译".into()) }
}

#[tauri::command]
fn get_capture(app: AppHandle, window: tauri::WebviewWindow, session_id: u64) -> Result<CapturePreview, String> {
    #[cfg(desktop)]
    { capture::get_capture(app, window, session_id) }
    #[cfg(mobile)]
    { let _ = (app, window, session_id); Err("移动端请从相册选择截图".into()) }
}

#[tauri::command]
fn capture_overlay_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    { capture::overlay_ready(app, window) }
    #[cfg(mobile)]
    { let _ = (app, window); Ok(()) }
}

#[tauri::command]
fn capture_ready(app: AppHandle, window: tauri::WebviewWindow, session_id: u64) -> Result<(), String> {
    #[cfg(desktop)]
    { capture::ready(app, window, session_id) }
    #[cfg(mobile)]
    { let _ = (app, window, session_id); Err("移动端请从相册选择截图".into()) }
}

#[tauri::command]
fn frontend_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主窗口可以更新准备状态".into()); }
    #[cfg(desktop)]
    {
        let state = app.state::<desktop::DesktopState>();
        state.frontend_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        if state.preferences_pending.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = app.emit_to("main", "fastdict://navigate", "settings");
        }
    }
    eprintln!("FastLingo: main frontend ready");
    diagnostics::main_ready(&app);
    Ok(())
}

#[tauri::command]
fn report_boot_error(app: AppHandle, window: tauri::WebviewWindow, stage: String) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主窗口可以提交启动阶段".into()); }
    diagnostics::report(&app, &stage)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn finish_capture(app: AppHandle, window: tauri::WebviewWindow, session_id: u64, x: u32, y: u32, width: u32, height: u32) -> Result<(), String> {
    #[cfg(desktop)]
    { capture::finish_capture(app, window, session_id, x, y, width, height).await }
    #[cfg(mobile)]
    { let _ = (app, window, session_id, x, y, width, height); Err("移动端请从相册选择截图".into()) }
}

#[tauri::command]
fn cancel_capture(app: AppHandle, window: tauri::WebviewWindow, session_id: u64) -> Result<(), String> {
    #[cfg(desktop)]
    { capture::cancel_capture(app, window, session_id) }
    #[cfg(mobile)]
    { let _ = (app, window, session_id); Ok(()) }
}

#[tauri::command]
async fn configure_shortcuts(app: AppHandle, capture_shortcut: String, clipboard_shortcut: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        // Validate before removing currently working bindings.
        let capture_key: tauri_plugin_global_shortcut::Shortcut = capture_shortcut.parse().map_err(|error| format!("截图快捷键无效：{error}"))?;
        let clipboard_key: tauri_plugin_global_shortcut::Shortcut = clipboard_shortcut.parse().map_err(|error| format!("复制快捷键无效：{error}"))?;
        if capture_key == clipboard_key { return Err("两项快捷键不能相同".into()); }
        let quit_key: tauri_plugin_global_shortcut::Shortcut = desktop::QUIT_SHORTCUT.parse().map_err(|_| "退出快捷键无效")?;
        if capture_key == quit_key || clipboard_key == quit_key { return Err(desktop::quit_reserved_message()); }
        let state = app.state::<desktop::DesktopState>();
        let _configuration = state.shortcut_configuration.lock().map_err(|_| "快捷键状态暂不可用")?;
        // Never hold the status lock while dispatching shortcut work to the UI
        // thread: a simultaneous status command would otherwise deadlock it.
        let previous = state.shortcuts.lock().map_err(|_| "快捷键状态暂不可用")?.clone();
        app.global_shortcut().unregister_all().map_err(|error| error.to_string())?;
        desktop::register_quit(&app);
        match desktop::register(&app, &capture_shortcut, &clipboard_shortcut) {
            Ok(()) => {
                let mut status = state.shortcuts.lock().map_err(|_| "快捷键状态暂不可用")?;
                status.capture_shortcut = capture_shortcut;
                status.clipboard_shortcut = clipboard_shortcut;
                status.error = None;
                Ok(())
            }
            Err(error) => {
                let _ = app.global_shortcut().unregister_all();
                desktop::register_quit(&app);
                if let Err(restore_error) = desktop::register(&app, &previous.capture_shortcut, &previous.clipboard_shortcut) {
                    if let Ok(mut status) = state.shortcuts.lock() { status.error = Some(restore_error); }
                }
                Err(error)
            }
        }
    }
    #[cfg(mobile)]
    { let _ = (app, capture_shortcut, clipboard_shortcut); Err("系统全局快捷键仅适用于桌面端".into()) }
}

#[tauri::command]
fn get_shortcut_status(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        let state = app.state::<desktop::DesktopState>();
        let status = state.shortcuts.lock().map_err(|_| "快捷键状态暂不可用")?;
        let mut value = serde_json::to_value(&*status).map_err(|error| error.to_string())?;
        value["frontendReady"] = serde_json::json!(state.frontend_ready.load(std::sync::atomic::Ordering::SeqCst));
        value["captureReady"] = serde_json::json!(capture::is_overlay_ready(&app));
        value["quitShortcut"] = serde_json::json!(desktop::QUIT_SHORTCUT);
        value["platform"] = serde_json::json!(std::env::consts::OS);
        Ok(value)
    }
    #[cfg(mobile)]
    { let _ = app; Ok(serde_json::json!({"captureShortcut": null, "clipboardShortcut": null, "quitShortcut": null, "platform": std::env::consts::OS, "error": null})) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(diagnostics::DiagnosticsState::default());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if app.try_state::<capture::CaptureState>().is_some() {
            if capture::restore_visible(app) || capture::is_active(app) { return; }
            let _ = expand_window_impl(app);
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fastdict_mobile::init())
        .plugin(tauri_plugin_http::init());
    #[cfg(desktop)]
    let builder = builder
        .manage(desktop::DesktopState::default())
        .manage(desktop_preferences::PreferencesState::default())
        .manage(capture::CaptureState::default())
        .on_menu_event(desktop::menu_event)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            show_sidebar, expand_window, hide_window, read_clipboard, write_clipboard,
            start_capture, get_capture, finish_capture, cancel_capture,
            capture_overlay_ready, capture_ready, frontend_ready,
            report_boot_error, quit_app,
            get_screen_permission, request_screen_permission, open_screen_permission_settings,
            configure_shortcuts, get_shortcut_status,
            desktop_preferences::get_desktop_preferences, desktop_preferences::set_desktop_preferences,
            secrets::save_api_key, secrets::get_api_key, secrets::delete_api_key,
            mobile::mobile_pick_image, mobile::mobile_share_text,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            desktop::setup(app)?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => diagnostics::page_loading(webview.app_handle(), webview.label()),
                tauri::webview::PageLoadEvent::Finished => diagnostics::page_finished(webview.app_handle(), webview.label()),
            }
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if desktop_preferences::should_hide_on_close(window.app_handle()) && window.hide().is_ok() {
                        api.prevent_close();
                        return;
                    }
                    // A native titlebar always provides a reliable exit, even if
                    // the frontend failed before registering its controls.
                    window.app_handle().exit(0);
                } else if window.label() == capture::OVERLAY_LABEL {
                    api.prevent_close();
                    match capture::cancel_window(window.app_handle()) {
                        Ok(true) => { let _ = show_sidebar_impl(window.app_handle()); }
                        _ => {},
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 FastLingo 失败");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if !capture::restore_visible(app) && !capture::is_active(app) {
                let _ = expand_window_impl(app);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
