//! API keys are deliberately kept outside provider metadata and frontend storage.
//! Windows and Apple targets use the OS credential vault. Android encrypts keys
//! with Android Keystore; unsupported desktop targets use session memory.

#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
const SERVICE: &str = "app.fastdict.api-keys";

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
static VAULT_LOCK: Mutex<()> = Mutex::new(());

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios", target_os = "android")))]
static SESSION_KEYS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty()
        || provider_id.len() > 128
        || !provider_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("API 配置标识无效".into());
    }
    Ok(())
}

fn validate_api_key(api_key: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("请输入 API Key".into());
    }
    if api_key.len() > 4096 || api_key.contains(['\0', '\r', '\n']) {
        return Err("API Key 格式无效".into());
    }
    Ok(())
}

async fn vault_task<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    // Credential prompts and OS IPC must never block the WebView's UI thread.
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "无法完成密钥存储操作，请重试".to_string())?
}

#[tauri::command]
pub async fn save_api_key(app: tauri::AppHandle, provider_id: String, api_key: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    validate_api_key(&api_key)?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    vault_task(move || {
        #[cfg(target_os = "android")]
        { app.state::<tauri_plugin_fastdict_mobile::Mobile<tauri::Wry>>().save_key(provider_id, api_key) }
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
        {
            // Serialize operations: some platform vaults cannot safely update
            // the same credential concurrently from different worker threads.
            let _guard = VAULT_LOCK
                .lock()
                .map_err(|_| "密钥保险库暂不可用".to_string())?;
            let entry = keyring::Entry::new(SERVICE, &provider_id)
                .map_err(|_| "无法访问系统密钥保险库".to_string())?;
            entry
                .set_password(&api_key)
                .map_err(|_| "无法保存 API Key，请检查系统密钥保险库权限".to_string())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            let mut keys = SESSION_KEYS
                .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
                .lock()
                .map_err(|_| "本次会话的密钥存储暂不可用".to_string())?;
            keys.insert(provider_id, api_key);
            Ok(())
        }
    })
    .await
}

#[tauri::command]
pub async fn get_api_key(app: tauri::AppHandle, provider_id: String) -> Result<Option<String>, String> {
    validate_provider_id(&provider_id)?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    vault_task(move || {
        #[cfg(target_os = "android")]
        { app.state::<tauri_plugin_fastdict_mobile::Mobile<tauri::Wry>>().get_key(provider_id) }
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
        {
            let _guard = VAULT_LOCK
                .lock()
                .map_err(|_| "密钥保险库暂不可用".to_string())?;
            let entry = keyring::Entry::new(SERVICE, &provider_id)
                .map_err(|_| "无法访问系统密钥保险库".to_string())?;
            match entry.get_password() {
                Ok(key) => Ok(Some(key)),
                Err(keyring::Error::NoEntry) => Ok(None),
                // Avoid formatting platform errors: they may contain secret bytes.
                Err(_) => Err("无法读取 API Key，请检查系统密钥保险库权限".into()),
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            let keys = SESSION_KEYS
                .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
                .lock()
                .map_err(|_| "本次会话的密钥存储暂不可用".to_string())?;
            Ok(keys.get(&provider_id).cloned())
        }
    })
    .await
}

#[tauri::command]
pub async fn delete_api_key(app: tauri::AppHandle, provider_id: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    vault_task(move || {
        #[cfg(target_os = "android")]
        { app.state::<tauri_plugin_fastdict_mobile::Mobile<tauri::Wry>>().delete_key(provider_id) }
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
        {
            let _guard = VAULT_LOCK
                .lock()
                .map_err(|_| "密钥保险库暂不可用".to_string())?;
            let entry = keyring::Entry::new(SERVICE, &provider_id)
                .map_err(|_| "无法访问系统密钥保险库".to_string())?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("无法删除 API Key，请检查系统密钥保险库权限".into()),
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            let mut keys = SESSION_KEYS
                .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
                .lock()
                .map_err(|_| "本次会话的密钥存储暂不可用".to_string())?;
            keys.remove(&provider_id);
            Ok(())
        }
    })
    .await
}
