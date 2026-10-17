//! Physical outer bounds must fit the monitor work area, including decorations.
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewWindow};

pub struct Layout { pub position: PhysicalPosition<i32>, pub inner: PhysicalSize<u32> }

pub fn layout(position: PhysicalPosition<i32>, area: PhysicalSize<u32>, scale: f64, frame: PhysicalSize<u32>) -> Layout {
    let margin = (16.0 * scale).round().max(0.0) as u32;
    let horizontal_margin = margin.min(area.width.saturating_sub(frame.width + 1) / 2);
    let vertical_margin = margin.min(area.height.saturating_sub(frame.height + 1) / 2);
    let available_width = area.width.saturating_sub(2 * horizontal_margin).saturating_sub(frame.width).max(1);
    let width = ((440.0 * scale).round() as u32).min(available_width).max(1);
    let height = area.height.saturating_sub(2 * vertical_margin).saturating_sub(frame.height).max(1);
    Layout {
        position: PhysicalPosition::new(
            (position.x as i64 + area.width as i64 - width as i64 - frame.width as i64 - horizontal_margin as i64) as i32,
            (position.y as i64 + vertical_margin as i64) as i32),
        inner: PhysicalSize::new(width, height),
    }
}

pub fn frame_size(window: &WebviewWindow, destination_scale: f64) -> PhysicalSize<u32> {
    #[cfg(target_os = "windows")]
    {
        // Query the frame for the destination DPI before sizing the client area.
        // A queued monitor move must not leave us using the old monitor's frame.
        #[repr(C)]
        struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32) -> isize;
            fn AdjustWindowRectExForDpi(rect: *mut Rect, style: u32, menu: i32, ex_style: u32, dpi: u32) -> i32;
        }
        if let Ok(hwnd) = window.hwnd() {
            let mut rect = Rect { left: 0, top: 0, right: 100, bottom: 100 };
            let adjusted = unsafe {
                let style = GetWindowLongPtrW(hwnd.0, -16) as u32;
                let ex_style = GetWindowLongPtrW(hwnd.0, -20) as u32;
                AdjustWindowRectExForDpi(&mut rect, style, 0, ex_style, (96.0 * destination_scale).round().max(96.0) as u32)
            };
            if adjusted != 0 {
                return PhysicalSize::new((rect.right - rect.left - 100).max(0) as u32, (rect.bottom - rect.top - 100).max(0) as u32);
            }
        }
    }
    let ratio = destination_scale / window.scale_factor().unwrap_or(destination_scale);
    window.outer_size().ok().zip(window.inner_size().ok()).map(|(outer, inner)| PhysicalSize::new(
        (outer.width.saturating_sub(inner.width) as f64 * ratio).ceil() as u32,
        (outer.height.saturating_sub(inner.height) as f64 * ratio).ceil() as u32,
    )).unwrap_or(PhysicalSize::new(0, 0))
}

fn contains(area_position: PhysicalPosition<i32>, area: PhysicalSize<u32>, position: PhysicalPosition<i32>, outer: PhysicalSize<u32>) -> bool {
    position.x >= area_position.x && position.y >= area_position.y
        && position.x as i64 + outer.width as i64 <= area_position.x as i64 + area.width as i64
        && position.y as i64 + outer.height as i64 <= area_position.y as i64 + area.height as i64
}

pub fn place(app: &AppHandle, window: &WebviewWindow, area_position: PhysicalPosition<i32>, area: PhysicalSize<u32>, scale: f64) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let window = window.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let mut frame = frame_size(&window, scale);
            // All setters and measurements run together on the persistent UI
            // thread, so a queued move cannot leave us measuring old bounds.
            for _ in 0..2 {
                let planned = layout(area_position, area, scale, frame);
                window.set_position(planned.position).map_err(|error| error.to_string())?;
                window.set_min_size(Some(PhysicalSize::new(
                    ((360.0 * scale).round() as u32).min(planned.inner.width),
                    ((480.0 * scale).round() as u32).min(planned.inner.height),
                ))).map_err(|error| error.to_string())?;
                window.set_size(planned.inner).map_err(|error| error.to_string())?;
                let outer = window.outer_size().map_err(|error| error.to_string())?;
                let inner = window.inner_size().map_err(|error| error.to_string())?;
                frame = PhysicalSize::new(outer.width.saturating_sub(inner.width),outer.height.saturating_sub(inner.height));
            }
            // Re-align with the measured destination frame, rather than the
            // provisional width used to cross monitors at the original DPI.
            let actual = window.outer_size().map_err(|error| error.to_string())?;
            let planned = layout(area_position, area, scale, frame);
            let x = (area_position.x as i64 + area.width as i64 - actual.width as i64
                - (16.0 * scale).round() as i64).max(area_position.x as i64) as i32;
            window.set_position(PhysicalPosition::new(x,planned.position.y)).map_err(|error| error.to_string())?;
            let position = window.outer_position().map_err(|error| error.to_string())?;
            let outer = window.outer_size().map_err(|error| error.to_string())?;
            if !contains(area_position,area,position,outer) { return Err("侧栏未能完整放入当前屏幕工作区域，请重试".into()); }
            Ok(())
        })();
        let _ = sender.send(result);
    }).map_err(|error| error.to_string())?;
    receiver.recv().map_err(|_| "侧栏窗口调整未完成".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decorated_sidebar_fits_all_work_area_edges_at_each_destination_dpi() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for position in [PhysicalPosition::new(0, 0), PhysicalPosition::new(-2560, 0), PhysicalPosition::new(0, -1440)] {
                // Bottom, top, left, and right taskbars yield different work areas.
                for (x, y, width, height) in [(0,0,1920,1032), (0,48,1920,1032), (64,0,1856,1080), (0,0,1856,1080)] {
                    let area_position = PhysicalPosition::new(position.x + x, position.y + y);
                    let area = PhysicalSize::new(width, height);
                    let frame = PhysicalSize::new((16.0 * scale) as u32, (39.0 * scale) as u32);
                    let sidebar = layout(area_position, area, scale, frame);
                    assert!(sidebar.position.x >= area_position.x);
                    assert!(sidebar.position.y >= area_position.y);
                    assert!(sidebar.position.x as i64 + sidebar.inner.width as i64 + frame.width as i64 <= area_position.x as i64 + width as i64);
                    assert!(sidebar.position.y as i64 + sidebar.inner.height as i64 + frame.height as i64 <= area_position.y as i64 + height as i64);
                    assert!(contains(area_position,area,sidebar.position,PhysicalSize::new(sidebar.inner.width+frame.width,sidebar.inner.height+frame.height)));
                }
            }
        }
    }
}
