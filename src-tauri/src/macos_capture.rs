//! macOS uses Apple's maintained, non-interactive full-display screenshot tool.
//! In-memory selection/cropping avoids the legacy `screencapture -R` path.
use image::RgbaImage;
use std::{fs, path::PathBuf, process::{Command, Stdio}, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct PrivateCaptureFile { directory: PathBuf, image: PathBuf }

impl PrivateCaptureFile {
    fn new() -> Result<Self, String> {
        let temporary_root = std::env::temp_dir();
        for _ in 0..8 {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let directory = temporary_root.join(format!("fastdict-capture-{}-{timestamp}-{sequence}", std::process::id()));
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(&directory) {
                Ok(()) => {
                    let file = Self { image: directory.join("screen.png"), directory };
                    let mut options = fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options.open(&file.image).map_err(|_| "无法创建临时截图文件".to_string())?;
                    return Ok(file);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法创建私有临时截图目录".into()),
            }
        }
        Err("无法创建私有临时截图目录".into())
    }
}

impl Drop for PrivateCaptureFile {
    fn drop(&mut self) {
        // Only these two paths, created by this invocation, are ever removed.
        // No recursive deletion, directory enumeration, or parent removal.
        let _ = fs::remove_file(&self.image);
        let _ = fs::remove_dir(&self.directory);
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn capture_monitor(monitor: &xcap::Monitor) -> Result<RgbaImage, String> {
    crate::macos::ensure_screen_permission()?;
    let id = monitor.id().map_err(|_| "无法读取当前显示器")?;
    // xcap preserves CGGetActiveDisplayList order. Apple documents that the main
    // display is first; screencapture -D uses 1 for main, 2 for secondary, etc.
    let displays = xcap::Monitor::all().map_err(|_| "无法枚举当前显示器")?;
    let ordinal = displays.iter().position(|display| display.id().ok() == Some(id))
        .ok_or("当前显示器已断开，请重新截图")? + 1;
    let output = PrivateCaptureFile::new()?;
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png", "-T", "0", "-D", &ordinal.to_string()])
        .arg(&output.image)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|_| "无法启动系统截图工具，请确认 macOS 的 /usr/sbin/screencapture 可用".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("系统截图超时，请重试；若持续失败，请检查 FastLingo 的屏幕录制权限并重新启动应用".into());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("无法等待系统截图完成，请重试".into());
            }
        }
    };
    if !status.success() {
        crate::macos::ensure_screen_permission()?;
        return Err("系统截图失败，请在系统设置中允许 FastLingo 屏幕录制，然后退出并重新打开应用".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output.image, fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法保护临时截图文件".to_string())?;
    }
    let current = xcap::Monitor::all().map_err(|_| "无法确认当前显示器，请重新截图")?;
    if current.get(ordinal - 1).and_then(|display| display.id().ok()) != Some(id) {
        return Err("显示器设置发生变化，请重新截图".into());
    }
    let bytes = fs::read(&output.image).map_err(|_| "无法读取系统截图".to_string())?;
    // Remove the file before decoding; retain only pixels in process memory.
    drop(output);
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| "系统截图不是有效的 PNG 图像".to_string())?.to_rgba8();
    if image.width() == 0 || image.height() == 0 { return Err("系统截图为空，请重试".into()); }
    // PNG dimensions are native backing pixels. Never downscale Retina glyphs.
    Ok(image)
}
