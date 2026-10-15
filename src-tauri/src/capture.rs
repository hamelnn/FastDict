//! Reuse a hidden selection WebView, showing it only after its image is decoded.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::{CompressionType, FilterType, PngEncoder}, ImageEncoder, RgbaImage};
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};
use crate::{Screenshot, CapturePreview};

pub const OVERLAY_LABEL: &str = "capture";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent { session_id: u64 }

struct CaptureFrame {
    image: RgbaImage,
    preview: Screenshot,
    x: i32,
    y: i32,
    monitor_width: u32,
    monitor_height: u32,
}

#[derive(Default)]
pub struct CaptureState { inner: Mutex<CaptureSession> }

#[derive(Default)]
struct CaptureSession {
    next_id: u64,
    overlay_ready: bool,
    active: Option<ActiveCapture>,
}

struct ActiveCapture {
    id: u64,
    frame: Option<CaptureFrame>,
    visible: bool,
    finishing: bool,
}

fn require_overlay(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != OVERLAY_LABEL { return Err("仅截图窗口可以操作屏幕图像".into()); }
    Ok(())
}

fn encode(image: &RgbaImage) -> Result<Screenshot, String> {
    let mut png = Vec::new();
    // Keep small glyphs exact while avoiding expensive default PNG compression.
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
        .map_err(|error| format!("无法编码截图：{error}"))?;
    Ok(Screenshot {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(png)),
        width: image.width(),
        height: image.height(),
    })
}

// Quartz display bounds and mouse locations both use logical coordinates.
#[cfg(target_os = "macos")]
fn cursor_point(_app: &AppHandle) -> Option<(i32, i32)> {
    crate::macos::cursor_point().map(|(x, y)| (x.floor() as i32, y.floor() as i32))
}

#[cfg(not(target_os = "macos"))]
fn cursor_point(app: &AppHandle) -> Option<(i32, i32)> {
    let point = app.get_webview_window("main")?.cursor_position().ok()?;
    Some((point.x.round() as i32, point.y.round() as i32))
}

fn take_frame(point: Option<(i32, i32)>) -> Result<CaptureFrame, String> {
    let monitor = point
        .and_then(|(x, y)| xcap::Monitor::from_point(x, y).ok())
        .or_else(|| {
            let monitors = xcap::Monitor::all().ok()?;
            monitors.iter().find(|monitor| monitor.is_primary().unwrap_or(false))
                .cloned().or_else(|| monitors.into_iter().next())
        })
        .ok_or_else(|| "没有找到可截图的显示器".to_string())?;
    #[cfg(target_os = "macos")]
    let image = crate::macos_capture::capture_monitor(&monitor)?;
    #[cfg(not(target_os = "macos"))]
    let image = monitor.capture_image().map_err(|error| format!("无法读取当前屏幕：{error}"))?;
    let preview = encode(&image)?;
    Ok(CaptureFrame {
        image,
        preview,
        x: monitor.x().map_err(|error| error.to_string())?,
        y: monitor.y().map_err(|error| error.to_string())?,
        monitor_width: monitor.width().map_err(|error| error.to_string())?,
        monitor_height: monitor.height().map_err(|error| error.to_string())?,
    })
}

/// Preload during setup, before global shortcuts can request screenshots.
pub fn preload(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() { return Ok(()); }
    let route = format!("index.html?capture=1&build={}", env!("CARGO_PKG_VERSION"));
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App(route.into()))
        .title("FastDict · 框选截图")
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(1.0, 1.0)
        .visible(false)
        .focused(false)
        .build().map_err(|error| error.to_string())?;
    Ok(())
}

pub async fn begin(app: AppHandle) -> Result<(), String> {
    // Preflight is side-effect free: global shortcuts never trigger TCC dialogs.
    crate::macos::ensure_screen_permission()?;
    let id = {
        let state = app.state::<CaptureState>();
        let mut inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        if inner.active.is_some() { return Err("截图选择正在进行，请先完成或按 Esc 取消".into()); }
        inner.next_id += 1;
        let id = inner.next_id;
        inner.active = Some(ActiveCapture { id, frame: None, visible: false, finishing: false });
        id
    };
    let result = begin_inner(&app, id).await;
    if result.is_err() && cleanup_session(&app, id) { let _ = crate::show_sidebar_impl(&app); }
    result
}

async fn begin_inner(app: &AppHandle, id: u64) -> Result<(), String> {
    let point = cursor_point(app);
    let main_was_visible = if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(true);
        window.hide().map_err(|error| error.to_string())?;
        visible
    } else { false };
    let window = app.get_webview_window(OVERLAY_LABEL).ok_or("截图窗口未能初始化，请重新启动应用")?;
    window.hide().map_err(|error| error.to_string())?;
    let frame = tauri::async_runtime::spawn_blocking(move || {
        if main_was_visible { std::thread::sleep(Duration::from_millis(35)); }
        take_frame(point)
    }).await.map_err(|error| error.to_string())??;
    let (x, y, width, height) = (frame.x, frame.y, frame.monitor_width, frame.monitor_height);
    {
        let state = app.state::<CaptureState>();
        let inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        if inner.active.as_ref().map(|active| active.id) != Some(id) { return Ok(()); }
    }

    // Fullscreen placement also covers the taskbar, at the destination DPI.
    #[cfg(target_os = "macos")]
    {
        window.set_simple_fullscreen(false).map_err(|error| error.to_string())?;
        window.set_position(tauri::LogicalPosition::new(x as f64, y as f64)).map_err(|error| error.to_string())?;
        window.set_size(tauri::LogicalSize::new(width as f64, height as f64)).map_err(|error| error.to_string())?;
        // Enter simple fullscreen only after the preview has decoded. Changing
        // NSApplication presentation while this window is hidden would briefly
        // hide the user's menu bar and Dock during screenshot preparation.
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_fullscreen(false).map_err(|error| error.to_string())?;
        window.set_position(PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
        window.set_size(PhysicalSize::new(width, height)).map_err(|error| error.to_string())?;
        window.set_fullscreen_on_monitor(PhysicalPosition::new(x as f64 + 1.0, y as f64 + 1.0))
            .map_err(|error| error.to_string())?;
    }

    let notify = {
        let state = app.state::<CaptureState>();
        let mut inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        let Some(active) = inner.active.as_mut().filter(|active| active.id == id) else { return Ok(()); };
        active.frame = Some(frame);
        inner.overlay_ready
    };
    if notify { emit_start(app, id)?; }
    let watchdog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let awaiting_image = {
            let state = watchdog_app.state::<CaptureState>();
            let pending = state.inner.lock().map(|inner| {
                inner.active.as_ref().map(|active| active.id == id && !active.visible).unwrap_or(false)
            }).unwrap_or(false);
            pending
        };
        if awaiting_image && cleanup_session(&watchdog_app, id) {
            if crate::show_sidebar_impl(&watchdog_app).is_ok() {
                let _ = watchdog_app.emit_to("main", "fastdict://error", "截图界面未能就绪，请重试或重新启动应用");
            }
        }
    });
    Ok(())
}

fn emit_start(app: &AppHandle, id: u64) -> Result<(), String> {
    app.emit_to(OVERLAY_LABEL, "fastdict://capture-start", SessionEvent { session_id: id }).map_err(|error| error.to_string())
}

pub fn overlay_ready(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_overlay(&window)?;
    let pending = {
        let state = app.state::<CaptureState>();
        let mut inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        inner.overlay_ready = true;
        inner.active.as_ref().filter(|active| active.frame.is_some() && !active.visible).map(|active| active.id)
    };
    if let Some(id) = pending { emit_start(&app, id)?; }
    eprintln!("FastDict: capture overlay ready");
    Ok(())
}

pub fn get_capture(app: AppHandle, window: WebviewWindow, session_id: u64) -> Result<CapturePreview, String> {
    require_overlay(&window)?;
    let state = app.state::<CaptureState>();
    let inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
    let screenshot = inner.active.as_ref().filter(|active| active.id == session_id)
        .and_then(|active| active.frame.as_ref()).map(|frame| frame.preview.clone()).ok_or("截图会话已结束")?;
    Ok(CapturePreview { screenshot, session_id })
}

pub fn ready(app: AppHandle, window: WebviewWindow, session_id: u64) -> Result<(), String> {
    require_overlay(&window)?;
    {
        let state = app.state::<CaptureState>();
        let mut inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        let active = inner.active.as_mut().filter(|active| active.id == session_id).ok_or("截图会话已结束")?;
        if active.frame.is_none() || active.finishing { return Err("截图尚未准备好".into()); }
        active.visible = true;
    }
    #[cfg(target_os = "macos")]
    {
        app.show().map_err(|error| error.to_string())?;
        window.set_simple_fullscreen(true).map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub async fn finish_capture(app: AppHandle, window: WebviewWindow, session_id: u64, x: u32, y: u32, width: u32, height: u32) -> Result<(), String> {
    require_overlay(&window)?;
    let image = {
        let state = app.state::<CaptureState>();
        let mut inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        let active = inner.active.as_mut().filter(|active| active.id == session_id).ok_or("截图会话已结束")?;
        if active.finishing { return Err("选区正在处理中".into()); }
        let image = &active.frame.as_ref().ok_or("截图已结束")?.image;
        if width == 0 || height == 0 || x >= image.width() || y >= image.height()
            || width > image.width() - x || height > image.height() - y { return Err("请选择屏幕内的有效区域".into()); }
        active.finishing = true;
        active.frame.take().ok_or("截图已结束")?.image
    };
    // Remove the overlay as soon as the user releases the selection.
    hide_overlay(&app);
    let result = tauri::async_runtime::spawn_blocking(move || {
        encode(&image::imageops::crop_imm(&image, x, y, width, height).to_image())
    }).await.map_err(|error| error.to_string()).and_then(|result| result);
    if !cleanup_session(&app, session_id) { return Ok(()); }
    crate::show_sidebar_impl(&app)?;
    let screenshot = result.map_err(|error| {
        let _ = app.emit_to("main", "fastdict://error", error.clone());
        error
    })?;
    app.emit_to("main", "fastdict://image", screenshot).map_err(|error| error.to_string())
}

pub fn cancel_capture(app: AppHandle, window: WebviewWindow, session_id: u64) -> Result<(), String> {
    require_overlay(&window)?;
    if cancel_session(&app, session_id)? { crate::show_sidebar_impl(&app)?; }
    Ok(())
}

pub fn cancel_window(app: &AppHandle) -> Result<bool, String> {
    let id = {
        let state = app.state::<CaptureState>();
        let inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
        inner.active.as_ref().map(|active| active.id)
    };
    match id { Some(id) => cancel_session(app, id), None => Ok(false) }
}

fn cancel_session(app: &AppHandle, id: u64) -> Result<bool, String> {
    let state = app.state::<CaptureState>();
    let mut inner = state.inner.lock().map_err(|_| "截图状态暂不可用")?;
    let Some(active) = inner.active.as_ref().filter(|active| active.id == id) else { return Ok(false); };
    if active.finishing { return Err("选区正在处理中，请稍候".into()); }
    hide_overlay(app);
    let _ = app.emit_to(OVERLAY_LABEL, "fastdict://capture-reset", SessionEvent { session_id: id });
    inner.active = None;
    Ok(true)
}

fn cleanup_session(app: &AppHandle, id: u64) -> bool {
    let state = app.state::<CaptureState>();
    let Ok(mut inner) = state.inner.lock() else { return false; };
    if inner.active.as_ref().map(|active| active.id) != Some(id) { return false; }
    hide_overlay(app);
    let _ = app.emit_to(OVERLAY_LABEL, "fastdict://capture-reset", SessionEvent { session_id: id });
    inner.active = None;
    true
}

fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
        #[cfg(target_os = "macos")]
        let _ = window.set_simple_fullscreen(false);
        #[cfg(not(target_os = "macos"))]
        let _ = window.set_fullscreen(false);
    }
}

pub fn is_active(app: &AppHandle) -> bool {
    app.state::<CaptureState>().inner.lock().map(|inner| inner.active.is_some()).unwrap_or(true)
}

pub fn is_overlay_ready(app: &AppHandle) -> bool {
    app.state::<CaptureState>().inner.lock().map(|inner| inner.overlay_ready).unwrap_or(false)
}

/// Dock reopen and Show recover a hidden *ready* selection without exposing a
/// window whose captured background is still being decoded.
pub fn restore_visible(app: &AppHandle) -> bool {
    let visible = app.state::<CaptureState>().inner.lock().map(|inner| {
        inner.active.as_ref().map(|active| active.visible && !active.finishing).unwrap_or(false)
    }).unwrap_or(false);
    if !visible { return false; }
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn screenshot_png_roundtrip_preserves_small_glyph_pixels() {
        let image = image::RgbaImage::from_fn(12, 8, |x, y| {
            if x == 3 || y == 4 { image::Rgba([0, 0, 0, 255]) } else { image::Rgba([255, 255, 255, 255]) }
        });
        let encoded = super::encode(&image).unwrap();
        let bytes = base64::Engine::decode(&super::STANDARD, encoded.data_url.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(decoded, image);
        assert_eq!((encoded.width, encoded.height), (12, 8));
    }
}
