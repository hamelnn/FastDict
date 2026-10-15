//! Small native bridge: system image picker, outgoing share sheet and Android vault.
use serde::{Deserialize, Serialize};
use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
#[cfg(mobile)]
use tauri::{Manager, plugin::PluginHandle};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(mobile)]
#[derive(Deserialize)]
struct ImageResponse { image: Option<PickedImage> }

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct KeyResponse { key: Option<String> }

#[cfg(mobile)]
pub struct Mobile<R: Runtime>(PluginHandle<R>);

#[cfg(mobile)]
impl<R: Runtime> Mobile<R> {
    pub fn pick_image(&self) -> Result<Option<PickedImage>, String> {
        self.0.run_mobile_plugin::<ImageResponse>("pickImage", ())
            .map(|response| response.image)
            .map_err(|error| error.to_string())
    }

    pub fn share_text(&self, text: String) -> Result<(), String> {
        self.0.run_mobile_plugin("shareText", serde_json::json!({"text": text}))
            .map_err(|_| "无法打开系统分享菜单，请重试".into())
    }

    #[cfg(target_os = "android")]
    pub fn save_key(&self, provider_id: String, api_key: String) -> Result<(), String> {
        self.0.run_mobile_plugin("saveKey", serde_json::json!({"providerId": provider_id, "apiKey": api_key}))
            .map_err(|_| "无法保存 API Key，请检查设备密钥存储后重试".into())
    }

    #[cfg(target_os = "android")]
    pub fn get_key(&self, provider_id: String) -> Result<Option<String>, String> {
        self.0.run_mobile_plugin::<KeyResponse>("getKey", serde_json::json!({"providerId": provider_id}))
            .map(|response| response.key)
            .map_err(|_| "无法读取 API Key，请在设置中重新保存密钥".into())
    }

    #[cfg(target_os = "android")]
    pub fn delete_key(&self, provider_id: String) -> Result<(), String> {
        self.0.run_mobile_plugin("deleteKey", serde_json::json!({"providerId": provider_id}))
            .map_err(|_| "无法删除 API Key，请重试".into())
    }
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_fastdict_mobile);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fastdict-mobile")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api.register_android_plugin("app.fastdict.mobile", "FastDictMobilePlugin")?;
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_fastdict_mobile)?;
            #[cfg(mobile)]
            _app.manage(Mobile(handle));
            Ok(())
        })
        .build()
}
