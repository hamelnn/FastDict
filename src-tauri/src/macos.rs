//! Small native macOS bridges; no screen permission prompt runs at startup.
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPermission {
    pub supported: bool,
    pub granted: bool,
    pub status: &'static str,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

pub fn screen_permission() -> ScreenPermission {
    #[cfg(target_os = "macos")]
    {
        let granted = unsafe { CGPreflightScreenCaptureAccess() };
        ScreenPermission { supported: true, granted, status: if granted { "granted" } else { "denied" } }
    }
    #[cfg(not(target_os = "macos"))]
    { ScreenPermission { supported: false, granted: true, status: "unsupported" } }
}

#[cfg(target_os = "macos")]
pub fn request_screen_permission() -> ScreenPermission {
    // The caller dispatches this explicit user action to the native main thread.
    unsafe { CGRequestScreenCaptureAccess(); }
    screen_permission()
}

#[cfg(desktop)]
pub fn ensure_screen_permission() -> Result<(), String> {
    if !screen_permission().granted {
        return Err("请在轻译设置中点击「允许屏幕录制」，或前往系统设置 → 隐私与安全性 → 屏幕录制（或屏幕与系统音频录制）启用 FastDict，然后退出并重新打开应用。".into());
    }
    Ok(())
}

// Both CGDisplayBounds and CGEventGetLocation use global logical Quartz points.
// Do not mix these with per-monitor Retina pixel positions.
#[cfg(target_os = "macos")]
pub fn cursor_point() -> Option<(f64, f64)> {
    use std::ffi::c_void;
    #[repr(C)]
    struct CGPoint { x: f64, y: f64 }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *const c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { fn CFRelease(value: *const c_void); }
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() { return None; }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Some((point.x, point.y))
    }
}

/// Kept type-checked on all desktop targets, instantiated only on macOS.
#[cfg(desktop)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn application_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Native, Submenu, WINDOW_SUBMENU_ID};
    let app_menu = Submenu::with_items(app, "FastDict", true, &[
        &Native::about(app, Some("关于 FastDict"), Some(AboutMetadata {
            name: Some("FastDict · 轻译".into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default()
        }))?,
        &Native::separator(app)?,
        &MenuItem::with_id(app, "preferences", "设置…", true, Some("Command+,"))?,
        &MenuItem::with_id(app, "show", "显示轻译", true, None::<&str>)?,
        &Native::separator(app)?,
        &Native::services(app, Some("服务"))?,
        &Native::separator(app)?,
        &Native::hide(app, Some("隐藏 FastDict"))?,
        &Native::hide_others(app, Some("隐藏其他"))?,
        &Native::show_all(app, Some("显示全部"))?,
        &Native::separator(app)?,
        // Custom native event exits immediately, independent of JavaScript.
        &MenuItem::with_id(app, "quit", "退出 FastDict", true, Some("Command+Q"))?,
    ])?;
    let edit_menu = Submenu::with_items(app, "编辑", true, &[
        &Native::undo(app, Some("撤销"))?, &Native::redo(app, Some("重做"))?,
        &Native::separator(app)?,
        &Native::cut(app, Some("剪切"))?, &Native::copy(app, Some("复制"))?,
        &Native::paste(app, Some("粘贴"))?, &Native::select_all(app, Some("全选"))?,
    ])?;
    let window_menu = Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, "窗口", true, &[
        &Native::minimize(app, Some("最小化"))?, &Native::maximize(app, Some("缩放"))?,
        &Native::separator(app)?, &Native::close_window(app, Some("关闭窗口"))?,
        &MenuItem::with_id(app, "show", "显示轻译", true, None::<&str>)?,
    ])?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

#[cfg(desktop)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn menu_bar_icon() -> tauri::image::Image<'static> {
    // Monochrome alpha-only template, letting macOS tint it for dark/light menus.
    let mut rgba = vec![0; 18 * 18 * 4];
    for y in 0..18 {
        for x in 0..18 {
            let frame = ((y == 2 || y == 15) && ((2..6).contains(&x) || (12..16).contains(&x)))
                || ((x == 2 || x == 15) && ((2..6).contains(&y) || (12..16).contains(&y)));
            let letter = ((6..8).contains(&x) && (5..14).contains(&y))
                || ((6..13).contains(&x) && (5..7).contains(&y))
                || ((6..12).contains(&x) && (9..11).contains(&y));
            if frame || letter { rgba[(y * 18 + x) * 4 + 3] = 255; }
        }
    }
    tauri::image::Image::new_owned(rgba, 18, 18)
}
