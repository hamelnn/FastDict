//! Native mobile functions are invoked only by an explicit action in the main UI.
use tauri::{AppHandle, WebviewWindow};
#[cfg(mobile)]
use tauri::Manager;

#[tauri::command]
pub async fn mobile_pick_image(app: AppHandle, window: WebviewWindow)
    -> Result<Option<tauri_plugin_fastdict_mobile::PickedImage>, String>
{
    if window.label() != "main" { return Err("请在主界面选择图片".into()); }
    #[cfg(mobile)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<tauri_plugin_fastdict_mobile::Mobile<tauri::Wry>>().pick_image()
        }).await.map_err(|_| "无法完成图片选择，请重试".to_string())?
    }
    #[cfg(desktop)]
    { let _ = app; Err("此功能仅用于 iOS 和 Android 应用".into()) }
}

#[tauri::command]
pub async fn mobile_share_text(app: AppHandle, window: WebviewWindow, text: String) -> Result<(), String> {
    if window.label() != "main" { return Err("请在主界面分享译文".into()); }
    if text.trim().is_empty() { return Err("请先生成译文".into()); }
    if text.chars().count() > 100_000 { return Err("文本过长，请分段分享".into()); }
    #[cfg(mobile)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<tauri_plugin_fastdict_mobile::Mobile<tauri::Wry>>().share_text(text)
        }).await.map_err(|_| "无法打开系统分享菜单，请重试".to_string())?
    }
    #[cfg(desktop)]
    { let _ = app; Err("此功能仅用于 iOS 和 Android 应用".into()) }
}
