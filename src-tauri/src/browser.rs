//! Browser URL dispatch goes through the OS URL handler, never Explorer paths.
use reqwest::Url;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const USAGE: &str = "https://chatgpt.com/settings/usage";
const FAILED: &str = "无法打开系统默认浏览器，请检查默认浏览器设置";

enum Destination { Authorization, Usage }
fn validate(value:&str,destination:Destination) -> Result<Url,String> {
    let url = Url::parse(value).map_err(|_|FAILED)?;
    let host_path = match destination {
        Destination::Authorization => url.host_str()==Some("auth.openai.com") && url.path()=="/api/accounts/authorize",
        Destination::Usage => url.host_str()==Some("chatgpt.com") && url.path()=="/settings/usage" && url.query().is_none(),
    };
    if !host_path || url.scheme()!="https" || url.port_or_known_default()!=Some(443)
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("浏览器目标地址无效".into());
    }
    Ok(url)
}

async fn open(app:&AppHandle,url:Url)->Result<(),String> {
    #[cfg(target_os="windows")]
    {
        // Windows shell handlers may require COM STA and a live message loop.
        // Tauri's main thread supplies both; an async worker or a short-lived
        // thread may return before an asynchronous shell activation completes.
        let (sender,receiver)=tokio::sync::oneshot::channel();
        let browser_app=app.clone();
        app.run_on_main_thread(move || {
            if sender.is_closed() { return; }
            let result=browser_app.opener().open_url(url.as_str(),None::<&str>)
                .map_err(|_|FAILED.to_string());
            let _=sender.send(result);
        }).map_err(|_|FAILED.to_string())?;
        receiver.await.map_err(|_|FAILED.to_string())?
    }
    #[cfg(not(target_os="windows"))]
    { app.opener().open_url(url.as_str(),None::<&str>).map_err(|_|FAILED.into()) }
}
pub async fn open_authorization(app:&AppHandle,url:&str)->Result<(),String> {
    open(app,validate(url,Destination::Authorization)?).await
}
pub async fn open_usage(app:&AppHandle)->Result<(),String> { open(app,validate(USAGE,Destination::Usage)?).await }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorization_query_is_preserved_for_os_url_dispatch() {
        let value="https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&scope=openid+profile+email&resource=https%3A%2F%2Fapi.openai.com%2Fv1&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=synthetic_state";
        assert_eq!(validate(value,Destination::Authorization).unwrap().as_str(),value);
    }
    #[test]
    fn browser_dispatch_accepts_only_the_two_official_destinations() {
        assert_eq!(validate(USAGE,Destination::Usage).unwrap().as_str(),USAGE);
        for value in ["file:///C:/Windows", "https://auth.openai.com.evil.test/api/accounts/authorize", "https://auth.openai.com:444/api/accounts/authorize",
            "https://auth.openai.com/api/accounts/authorize#fragment", "https://user@auth.openai.com/api/accounts/authorize", "http://auth.openai.com/api/accounts/authorize"] {
            assert!(validate(value,Destination::Authorization).is_err());
        }
        assert!(validate("https://chatgpt.com/settings/usage?redirect=other",Destination::Usage).is_err());
    }
}
