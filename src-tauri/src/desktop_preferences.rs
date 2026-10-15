//! Desktop behavior is loaded before the renderer and never depends on localStorage.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    #[default]
    Quit,
    Tray,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredPreferences {
    close_action: CloseAction,
    launch_at_login: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    close_action: CloseAction,
    launch_at_login: bool,
    tray_available: bool,
    autostart_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    autostart_error: Option<String>,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("请在主窗口修改桌面设置".into()); }
    Ok(())
}

#[tauri::command]
pub async fn get_desktop_preferences(app: AppHandle, window: WebviewWindow) -> Result<DesktopPreferences, String> {
    require_main(&window)?;
    #[cfg(desktop)]
    { tauri::async_runtime::spawn_blocking(move || native::get(&app)).await.map_err(|_| "无法读取桌面设置")? }
    #[cfg(mobile)]
    { let _ = app; Err("此设置仅适用于桌面应用".into()) }
}

#[tauri::command]
pub async fn set_desktop_preferences(app: AppHandle, window: WebviewWindow, close_action: CloseAction, launch_at_login: bool,
    update_launch_at_login: Option<bool>) -> Result<DesktopPreferences, String> {
    require_main(&window)?;
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || native::set(&app, StoredPreferences { close_action, launch_at_login }, update_launch_at_login.unwrap_or(false)))
            .await.map_err(|_| "无法保存桌面设置")?
    }
    #[cfg(mobile)]
    { let _ = (app, close_action, launch_at_login, update_launch_at_login); Err("此设置仅适用于桌面应用".into()) }
}

#[cfg(desktop)]
pub use native::{initialize, should_hide_on_close, PreferencesState};

#[cfg(desktop)]
mod native {
    use super::*;
    use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
    use tauri::Manager;

    #[derive(Default)]
    pub struct PreferencesState {
        current: Mutex<StoredPreferences>,
        configuration: Mutex<()>,
        close_to_tray: AtomicBool,
    }

    fn path(app: &AppHandle) -> Result<PathBuf, String> {
        app.path().app_config_dir().map(|directory| directory.join("desktop-preferences.json"))
            .map_err(|_| "无法访问桌面设置目录".into())
    }

    fn read(path: &Path) -> Result<StoredPreferences, String> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "桌面设置文件无法读取，将使用默认关闭行为".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoredPreferences::default()),
            Err(_) => Err("无法读取桌面设置，将使用默认关闭行为".into()),
        }
    }

    fn persist(path: &Path, value: &StoredPreferences) -> Result<(), String> {
        let directory = path.parent().ok_or("桌面设置目录无效")?;
        fs::create_dir_all(directory).map_err(|_| "无法创建桌面设置目录")?;
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法保存桌面设置")?;
        let temporary = path.with_extension("json.tmp");
        let result = (|| {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            // Same-directory rename replaces atomically on the supported desktops.
            fs::rename(&temporary, path)
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result.map_err(|_| "无法保存桌面设置，请检查配置目录的写入权限".into())
    }

    pub fn initialize(app: &AppHandle) {
        let state = app.state::<PreferencesState>();
        match path(app).and_then(|path| read(&path)) {
            Ok(value) => {
                state.close_to_tray.store(value.close_action == CloseAction::Tray, Ordering::SeqCst);
                if let Ok(mut current) = state.current.lock() { *current = value; }
            }
            Err(_) => crate::diagnostics::record(app, "desktop-preferences-load-failed"),
        }
        // Building the manager only resolves paths. Never enable/disable at startup;
        // a user's later change in their OS startup settings must be respected.
        if app.plugin(tauri_plugin_autostart::Builder::new().app_name("FastLingo").build()).is_err() {
            crate::diagnostics::record(app, "autostart-unavailable");
        }
    }

    fn hide_allowed(close_to_tray: bool, tray_ready: bool, frontend_ready: bool) -> bool {
        close_to_tray && tray_ready && frontend_ready
    }

    pub fn should_hide_on_close(app: &AppHandle) -> bool {
        let state = app.state::<PreferencesState>();
        let desktop = app.state::<crate::desktop::DesktopState>();
        hide_allowed(state.close_to_tray.load(Ordering::SeqCst),
            desktop.tray_ready.load(Ordering::SeqCst), desktop.frontend_ready.load(Ordering::SeqCst))
    }

    trait Autostart {
        fn enabled(&self) -> Result<bool, String>;
        fn set_enabled(&self, enabled: bool) -> Result<(), String>;
    }

    struct SystemAutostart<'a>(&'a AppHandle);
    impl Autostart for SystemAutostart<'_> {
        fn enabled(&self) -> Result<bool, String> {
            self.0.try_state::<tauri_plugin_autostart::AutoLaunchManager>().ok_or("开机启动服务暂不可用")?
                .is_enabled().map_err(|error| format!("无法读取系统开机启动设置：{error}"))
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            let manager = self.0.try_state::<tauri_plugin_autostart::AutoLaunchManager>().ok_or("开机启动服务暂不可用")?;
            (if enabled { manager.enable() } else { manager.disable() })
                .map_err(|error| format!("无法{}开机启动：{error}", if enabled { "启用" } else { "关闭" }))
        }
    }

    fn snapshot(app: &AppHandle, current: &StoredPreferences) -> DesktopPreferences {
        let status = SystemAutostart(app).enabled();
        DesktopPreferences {
            close_action: current.close_action,
            launch_at_login: status.as_ref().copied().unwrap_or(current.launch_at_login),
            tray_available: app.state::<crate::desktop::DesktopState>().tray_ready.load(Ordering::SeqCst),
            autostart_available: status.is_ok(),
            autostart_error: status.err(),
        }
    }

    pub(super) fn get(app: &AppHandle) -> Result<DesktopPreferences, String> {
        let state = app.state::<PreferencesState>();
        let _configuration = state.configuration.lock().map_err(|_| "桌面设置暂不可用")?;
        let current = state.current.lock().map_err(|_| "桌面设置暂不可用")?.clone();
        Ok(snapshot(app, &current))
    }

    fn rollback(backend: &impl Autostart, before: bool, error: String) -> String {
        match backend.set_enabled(before) {
            Ok(()) => error,
            Err(_) => format!("{error}；恢复原开机启动状态失败，请检查系统启动设置"),
        }
    }

    fn apply_update(backend: &impl Autostart, current: &StoredPreferences, requested: &StoredPreferences, update_launch_at_login: bool,
        persist: impl FnOnce(&StoredPreferences) -> Result<(), String>) -> Result<StoredPreferences, String> {
        let status = backend.enabled();
        // A stale settings panel must never undo a change made in the OS. Only
        // an explicit startup-toggle action is allowed to write a startup entry.
        if !update_launch_at_login {
            let mut effective = requested.clone();
            effective.launch_at_login = status.unwrap_or(current.launch_at_login);
            persist(&effective)?;
            return Ok(effective);
        }
        let changed_from = Some(status?).filter(|before| *before != requested.launch_at_login);
        if let Some(before) = changed_from {
            if let Err(error) = backend.set_enabled(requested.launch_at_login) {
                return Err(rollback(backend, before, error));
            }
            match backend.enabled() {
                Ok(enabled) if enabled == requested.launch_at_login => {},
                _ => return Err(rollback(backend, before, "系统未确认开机启动设置已生效，请检查系统启动设置".into())),
            }
        }
        if let Err(error) = persist(requested) {
            return Err(match changed_from { Some(before) => rollback(backend, before, error), None => error });
        }
        Ok(requested.clone())
    }

    pub(super) fn set(app: &AppHandle, requested: StoredPreferences, update_launch_at_login: bool) -> Result<DesktopPreferences, String> {
        let state = app.state::<PreferencesState>();
        let _configuration = state.configuration.lock().map_err(|_| "桌面设置暂不可用")?;
        let current = state.current.lock().map_err(|_| "桌面设置暂不可用")?.clone();
        if requested.close_action == CloseAction::Tray
            && !app.state::<crate::desktop::DesktopState>().tray_ready.load(Ordering::SeqCst) {
            return Err("系统托盘暂不可用，请选择直接退出".into());
        }
        let path = path(app)?;
        let effective = apply_update(&SystemAutostart(app), &current, &requested, update_launch_at_login, |value| persist(&path, value))?;
        *state.current.lock().map_err(|_| "桌面设置暂不可用")? = effective.clone();
        state.close_to_tray.store(effective.close_action == CloseAction::Tray, Ordering::SeqCst);
        Ok(snapshot(app, &effective))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::{Cell, RefCell};
        struct FakeAutostart { enabled: Cell<bool>, unavailable: bool, reject: bool, ignore_change: bool, calls: RefCell<Vec<bool>> }
        impl Default for FakeAutostart {
            fn default() -> Self { Self { enabled: Cell::new(false), unavailable: false, reject: false, ignore_change: false, calls: RefCell::new(Vec::new()) } }
        }
        impl Autostart for FakeAutostart {
            fn enabled(&self) -> Result<bool, String> { if self.unavailable { Err("unavailable".into()) } else { Ok(self.enabled.get()) } }
            fn set_enabled(&self, enabled: bool) -> Result<(), String> {
                self.calls.borrow_mut().push(enabled);
                if self.reject { return Err("denied".into()); }
                if !self.ignore_change { self.enabled.set(enabled); }
                Ok(())
            }
        }
        #[test]
        fn defaults_and_close_fallbacks_allow_a_reliable_exit() {
            let value: StoredPreferences = serde_json::from_str("{}").unwrap();
            assert_eq!(value, StoredPreferences::default());
            assert_eq!(value.close_action, CloseAction::Quit);
            assert!(!value.launch_at_login);
            for (tray, frontend) in [(false, false), (false, true), (true, false)] { assert!(!hide_allowed(true, tray, frontend)); }
            assert!(!hide_allowed(false, true, true));
            assert!(hide_allowed(true, true, true));
            assert!(serde_json::from_str::<StoredPreferences>(r#"{"closeAction":"unknown"}"#).is_err());
        }
        #[test]
        fn close_only_update_does_not_touch_startup_even_when_unavailable() {
            let requested = StoredPreferences { close_action: CloseAction::Tray, ..Default::default() };
            for unavailable in [false, true] {
                let backend = FakeAutostart { unavailable, ..Default::default() };
                let persisted = Cell::new(false);
                apply_update(&backend, &StoredPreferences::default(), &requested, false, |_| { persisted.set(true); Ok(()) }).unwrap();
                assert!(persisted.get()); assert!(backend.calls.borrow().is_empty());
            }
        }
        #[test]
        fn failed_startup_change_does_not_save_the_requested_settings() {
            let backend = FakeAutostart { reject: true, ..Default::default() };
            let requested = StoredPreferences { launch_at_login: true, ..Default::default() };
            assert!(apply_update(&backend, &StoredPreferences::default(), &requested, true, |_| panic!("must not persist failed change")).is_err());
            assert!(!backend.enabled.get());
        }
        #[test]
        fn failed_persistence_restores_the_previous_startup_state() {
            let backend = FakeAutostart::default();
            let requested = StoredPreferences { launch_at_login: true, ..Default::default() };
            assert!(apply_update(&backend, &StoredPreferences::default(), &requested, true, |_| Err("disk full".into())).is_err());
            assert!(!backend.enabled.get()); assert_eq!(*backend.calls.borrow(), vec![true, false]);
        }
        #[test]
        fn ignored_os_change_is_rejected_and_rolled_back() {
            let backend = FakeAutostart { ignore_change: true, ..Default::default() };
            let requested = StoredPreferences { launch_at_login: true, ..Default::default() };
            assert!(apply_update(&backend, &StoredPreferences::default(), &requested, true, |_| panic!("must not save an ineffective change")).is_err());
            assert!(!backend.enabled.get()); assert_eq!(*backend.calls.borrow(), vec![true, false]);
        }
        #[test]
        fn startup_round_trip_uses_actual_os_state() {
            let backend = FakeAutostart::default();
            let enabled = StoredPreferences { launch_at_login: true, ..Default::default() };
            apply_update(&backend, &StoredPreferences::default(), &enabled, true, |_| Ok(())).unwrap();
            assert!(backend.enabled.get());
            apply_update(&backend, &enabled, &StoredPreferences::default(), true, |_| Ok(())).unwrap();
            assert!(!backend.enabled.get()); assert_eq!(*backend.calls.borrow(), vec![true, false]);
        }
        #[test]
        fn close_only_update_preserves_external_startup_change_and_refreshes_saved_state() {
            let backend = FakeAutostart { enabled: Cell::new(true), ..Default::default() };
            let stale_panel = StoredPreferences { close_action: CloseAction::Tray, launch_at_login: false };
            let persisted = RefCell::new(StoredPreferences::default());
            let effective = apply_update(&backend, &StoredPreferences::default(), &stale_panel, false,
                |value| { *persisted.borrow_mut() = value.clone(); Ok(()) }).unwrap();
            assert!(effective.launch_at_login); assert!(persisted.borrow().launch_at_login);
            assert_eq!(effective.close_action, CloseAction::Tray);
            assert!(backend.enabled.get()); assert!(backend.calls.borrow().is_empty());
        }
        #[test]
        fn settings_file_replaces_previous_value_and_detects_corruption() {
            let directory = std::env::temp_dir().join(format!("fastdict-preferences-test-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            let path = directory.join("desktop-preferences.json");
            assert_eq!(read(&path).unwrap(), StoredPreferences::default());
            let enabled = StoredPreferences { close_action: CloseAction::Tray, launch_at_login: true };
            persist(&path, &enabled).unwrap(); assert_eq!(read(&path).unwrap(), enabled);
            persist(&path, &StoredPreferences::default()).unwrap(); assert_eq!(read(&path).unwrap(), StoredPreferences::default());
            fs::write(&path, b"invalid json").unwrap(); assert!(read(&path).is_err());
            fs::remove_file(path).unwrap(); fs::remove_dir(directory).unwrap();
        }
    }
}
