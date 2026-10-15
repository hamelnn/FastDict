//! Independent Sign in with ChatGPT for the local open-source application.
//! Tokens never cross the WebView boundary and never use the Codex credential store.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub plan_enabled: bool,
    pub account_label: Option<String>,
    pub client_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: String,
    pub label: String,
    pub active: bool,
    pub connected: bool,
    pub plan_enabled: bool,
}

// Deliberately neither Debug nor Serialize. Only the native HTTP transport sees this.
pub(crate) struct Credentials {
    pub(crate) access_token: String,
    pub(crate) client_id: String,
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
impl Drop for Credentials {
    fn drop(&mut self) { use zeroize::Zeroize; self.access_token.zeroize(); }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use native::{AuthState, cancel_sign_in, credentials, disconnect, invalidate_and_refresh,
    profiles, select_profile, shutdown, sign_in, status};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported {
    use super::*;
    #[derive(Default)]
    pub struct AuthState;
    const UNSUPPORTED: &str = "ChatGPT 登录目前仅支持 Windows 和 macOS 桌面应用";
    pub async fn status(_: &AppHandle) -> Result<ConnectionStatus, String> { Err(UNSUPPORTED.into()) }
    pub async fn sign_in(_: &AppHandle, _: bool) -> Result<ConnectionStatus, String> { Err(UNSUPPORTED.into()) }
    pub fn cancel_sign_in(_: &AppHandle) {}
    pub fn shutdown(_: &AppHandle) {}
    pub async fn disconnect(_: &AppHandle) -> Result<ConnectionStatus, String> { Err(UNSUPPORTED.into()) }
    pub async fn credentials(_: &AppHandle) -> Result<Credentials, String> { Err(UNSUPPORTED.into()) }
    pub async fn invalidate_and_refresh(_: &AppHandle, _: &str, _: &str) -> Result<Credentials, String> { Err(UNSUPPORTED.into()) }
    pub async fn profiles(_: &AppHandle) -> Result<Vec<ProfileInfo>, String> { Err(UNSUPPORTED.into()) }
    pub async fn select_profile(_: &AppHandle, _: &str) -> Result<ConnectionStatus, String> { Err(UNSUPPORTED.into()) }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use unsupported::*;

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod native {
    use super::*;
    use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use fs2::FileExt;
    use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
    use rand::{rngs::OsRng, RngCore};
    use reqwest::{Client, Url};
    use sha2::{Digest, Sha256};
    use std::{collections::HashMap, fs::{self, File, OpenOptions}, future::Future,
        io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
    use tauri::Manager;
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::Notify};
    use uuid::Uuid;
    use zeroize::{Zeroize, Zeroizing};

    const ISSUER: &str = "https://auth.openai.com";
    const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
    const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
    const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
    const RESOURCE: &str = "https://api.openai.com/v1";
    const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
    const VAULT_SERVICE: &str = "app.fastdict.chatgpt-oauth";
    const VAULT_ACCOUNT: &str = "credential-encryption-key-v1";
    const MAGIC: &[u8] = b"FASTLINGO-SIWC-1\0";
    const AAD: &[u8] = b"FastLingo/app.fastdict.translate/siwc-v1";
    const MAX_STORE: u64 = 2 * 1024 * 1024;
    const MAX_HTTP: usize = 1024 * 1024;
    const CANCELLED: &str = "已取消 ChatGPT 登录";
    const STORAGE: &str = "无法访问 ChatGPT 的安全凭据存储，请检查系统密钥保险库和应用目录权限";
    const INVALID_IDENTITY: &str = "ChatGPT 身份验证失败，请重新登录";
    const RECONNECT: &str = "ChatGPT 登录已失效，请重新登录";
    const NETWORK: &str = "无法连接 ChatGPT 登录服务，请检查网络后重试";

    #[derive(Default)]
    pub struct AuthState {
        // Covers refresh, logout, and profile commits. The disk lock also covers other processes.
        operation: tokio::sync::Mutex<()>,
        pending: Mutex<Option<Arc<Attempt>>>,
        stopping: AtomicBool,
    }

    struct Attempt {
        cancelled: AtomicBool,
        notify: Notify,
        commit_gate: Mutex<()>,
    }
    impl Attempt {
        fn new() -> Self { Self { cancelled: AtomicBool::new(false), notify: Notify::new(), commit_gate: Mutex::new(()) } }
        fn cancel(&self) {
            // Cancellation and an atomic disk commit have a single ordering point.
            // Once cancel returns, a pending worker cannot publish credentials later.
            let _commit = self.commit_gate.lock();
            self.cancelled.store(true, Ordering::SeqCst);
            self.notify.notify_waiters();
            self.notify.notify_one();
        }
        fn check(&self) -> Result<(), String> {
            if self.cancelled.load(Ordering::SeqCst) { Err(CANCELLED.into()) } else { Ok(()) }
        }
        fn commit<T>(&self, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
            let _commit = self.commit_gate.lock().map_err(|_| CANCELLED)?;
            self.check()?;
            work()
        }
        async fn run<T>(&self, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
            self.check()?;
            tokio::select! {
                biased;
                _ = self.notify.notified() => Err(CANCELLED.into()),
                result = future => { self.check()?; result }
            }
        }
    }

    #[derive(Clone, Serialize, Deserialize)]
    struct TokenSet {
        access_token: String,
        refresh_token: Option<String>,
        id_token: String,
        scopes: Vec<String>,
        expires_at: u64,
        earliest_refresh_at: Option<u64>,
    }
    impl Drop for TokenSet {
        fn drop(&mut self) {
            self.access_token.zeroize();
            if let Some(token) = self.refresh_token.as_mut() { token.zeroize(); }
            self.id_token.zeroize();
        }
    }
    #[derive(Clone, Serialize, Deserialize)]
    struct Profile {
        id: String,
        label: String,
        client_id: String,
        issuer: Option<String>,
        subject: Option<String>,
        email: Option<String>,
        tokens: Option<TokenSet>,
    }
    #[derive(Clone, Serialize, Deserialize)]
    struct Database {
        version: u8,
        host_id: String,
        active: Option<String>,
        pending_profile: Option<String>,
        profiles: Vec<Profile>,
    }
    impl Default for Database {
        fn default() -> Self {
            Self { version: 1, host_id: format!("urn:uuid:{}", Uuid::new_v4()),
                active: None, pending_profile: None, profiles: Vec::new() }
        }
    }
    impl Database {
        fn active_profile(&self) -> Option<&Profile> {
            self.active.as_ref().and_then(|id| self.profiles.iter().find(|profile| &profile.id == id))
        }
        fn validate(&self) -> Result<(), String> {
            let host = self.host_id.strip_prefix("urn:uuid:").and_then(|value| Uuid::parse_str(value).ok());
            if self.version != 1 || !host.is_some_and(|value| value.get_version_num() == 4) || self.profiles.len() > 64 {
                return Err(STORAGE.into());
            }
            let mut ids = std::collections::HashSet::new();
            let mut clients = std::collections::HashSet::new();
            for profile in &self.profiles {
                if !ids.insert(&profile.id) || !clients.insert(&profile.client_id) || !valid_client(&profile.client_id)
                    || Uuid::parse_str(&profile.id).is_err() || profile.label.len() > 512
                    || profile.issuer.as_deref().is_some_and(|value| value != ISSUER)
                    || profile.tokens.is_some() && (profile.subject.as_ref().is_none_or(String::is_empty) || profile.issuer.is_none()) {
                    return Err(STORAGE.into());
                }
            }
            if self.active.as_ref().is_some_and(|id| !ids.contains(id))
                || self.pending_profile.as_ref().is_some_and(|id| !ids.contains(id)) { return Err(STORAGE.into()); }
            Ok(())
        }
    }

    struct Store {
        database: Database,
        key: Option<Zeroizing<[u8; 32]>>,
        path: PathBuf,
        _lock: File,
    }
    impl Store {
        fn open(directory: &Path) -> Result<Self, String> {
            fs::create_dir_all(directory).map_err(|_| STORAGE)?;
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|_| STORAGE)?;
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let lock = options.open(directory.join("session.lock")).map_err(|_| STORAGE)?;
            let started = Instant::now();
            loop {
                match lock.try_lock_exclusive() {
                    Ok(()) => break,
                    Err(error) if (error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error())
                        && started.elapsed() < Duration::from_secs(5) => {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => return Err("ChatGPT 连接正在更新，请稍后重试".into()),
                }
            }
            let path = directory.join("credentials.enc");
            let mut store = Self { database: Database::default(), key: None, path, _lock: lock };
            match fs::metadata(&store.path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(store),
                Ok(metadata) if metadata.len() <= MAX_STORE => (),
                _ => return Err(STORAGE.into()),
            }
            let bytes = fs::read(&store.path).map_err(|_| STORAGE)?;
            if bytes.len() <= MAGIC.len() + 12 || !bytes.starts_with(MAGIC) { return Err(STORAGE.into()); }
            let key = read_key(false)?;
            let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| STORAGE)?;
            let nonce = Nonce::from_slice(&bytes[MAGIC.len()..MAGIC.len() + 12]);
            let plaintext = Zeroizing::new(cipher.decrypt(nonce, Payload { msg: &bytes[MAGIC.len() + 12..], aad: AAD })
                .map_err(|_| STORAGE)?);
            store.database = serde_json::from_slice(&plaintext).map_err(|_| STORAGE)?;
            store.database.validate()?;
            store.key = Some(key);
            Ok(store)
        }
        fn encrypted_record(&mut self) -> Result<Vec<u8>, String> {
            self.database.validate()?;
            if self.key.is_none() { self.key = Some(read_key(true)?); }
            let key = self.key.as_ref().ok_or(STORAGE)?;
            let plaintext = Zeroizing::new(serde_json::to_vec(&self.database).map_err(|_| STORAGE)?);
            let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| STORAGE)?;
            let mut nonce = [0_u8; 12]; OsRng.fill_bytes(&mut nonce);
            let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: AAD }).map_err(|_| STORAGE)?;
            let mut bytes = Vec::with_capacity(MAGIC.len() + nonce.len() + encrypted.len());
            bytes.extend_from_slice(MAGIC); bytes.extend_from_slice(&nonce); bytes.extend_from_slice(&encrypted);
            if bytes.len() as u64 > MAX_STORE { return Err("ChatGPT 连接记录过多，无法安全保存新连接".into()); }
            Ok(bytes)
        }
    }

    fn read_key(create: bool) -> Result<Zeroizing<[u8; 32]>, String> {
        let entry = keyring::Entry::new(VAULT_SERVICE, VAULT_ACCOUNT).map_err(|_| STORAGE)?;
        let encoded = match entry.get_password() {
            Ok(value) => Zeroizing::new(value),
            Err(keyring::Error::NoEntry) if create => {
                let mut key = Zeroizing::new([0_u8; 32]); OsRng.fill_bytes(key.as_mut());
                let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(key.as_ref()));
                entry.set_password(&encoded).map_err(|_| STORAGE)?;
                return Ok(key);
            }
            _ => return Err(STORAGE.into()),
        };
        let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| STORAGE)?);
        let key: [u8; 32] = decoded.as_slice().try_into().map_err(|_| STORAGE)?;
        Ok(Zeroizing::new(key))
    }

    fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut options = OpenOptions::new(); options.write(true).create_new(true);
            #[cfg(unix)]
            { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut file = options.open(&temporary)?;
            file.write_all(bytes)?; file.sync_all()?; drop(file);
            fs::rename(&temporary, path)?;
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                // The rename already committed. A directory sync failure must not
                // report that the old record is still active after replacement.
                let _ = File::open(parent).and_then(|directory| directory.sync_all());
            }
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result.map_err(|_| STORAGE.into())
    }

    fn store_directory(app: &AppHandle) -> Result<PathBuf, String> {
        app.path().app_config_dir().map(|path| path.join("chatgpt-oauth")).map_err(|_| STORAGE.into())
    }
    async fn open_store(app: &AppHandle) -> Result<Store, String> {
        let directory = store_directory(app)?;
        tauri::async_runtime::spawn_blocking(move || Store::open(&directory)).await.map_err(|_| STORAGE)?
    }
    async fn save_store(mut store: Store, attempt: Option<Arc<Attempt>>) -> Result<Store, String> {
        tauri::async_runtime::spawn_blocking(move || {
            // OS vault prompts and encryption happen outside the commit gate so
            // cancellation stays responsive even if the platform vault is busy.
            let bytes = store.encrypted_record()?;
            match attempt { Some(attempt) => attempt.commit(|| atomic_write(&store.path, &bytes))?,
                None => atomic_write(&store.path, &bytes)? }
            Ok(store)
        }).await.map_err(|_| STORAGE)?
    }

    fn valid_client(client: &str) -> bool {
        client != DYNAMIC_CLIENT && !client.is_empty() && client.len() <= 256
            && client.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    }
    fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or(0) }
    fn plan_enabled(tokens: &TokenSet) -> bool {
        ["chatgpt.tokens.use.direct", "resource.invoke"].iter().all(|scope| tokens.scopes.iter().any(|item| item == scope))
    }
    fn connection(database: &Database, message: Option<String>) -> ConnectionStatus {
        let profile = database.active_profile();
        ConnectionStatus { connected: profile.is_some_and(|profile| profile.tokens.is_some()),
            plan_enabled: profile.and_then(|profile| profile.tokens.as_ref()).is_some_and(plan_enabled),
            account_label: profile.map(|profile| label(profile)),
            client_id: profile.map(|profile| profile.client_id.clone()), message }
    }
    fn label(profile: &Profile) -> String {
        match profile.email.as_ref() { Some(email) => format!("{} · {}", email, profile.label), None => profile.label.clone() }
    }

    pub async fn status(app: &AppHandle) -> Result<ConnectionStatus, String> {
        let state = app.state::<AuthState>();
        let _operation = state.operation.lock().await;
        let store = open_store(app).await?;
        Ok(connection(&store.database, None))
    }
    pub async fn profiles(app: &AppHandle) -> Result<Vec<ProfileInfo>, String> {
        let state = app.state::<AuthState>();
        let _operation = state.operation.lock().await;
        let store = open_store(app).await?;
        Ok(store.database.profiles.iter().map(|profile| ProfileInfo { id: profile.id.clone(), label: label(profile),
            active: store.database.active.as_ref() == Some(&profile.id), connected: profile.tokens.is_some(),
            plan_enabled: profile.tokens.as_ref().is_some_and(plan_enabled) }).collect())
    }
    pub async fn select_profile(app: &AppHandle, profile_id: &str) -> Result<ConnectionStatus, String> {
        cancel_sign_in(app);
        let state = app.state::<AuthState>();
        let _operation = state.operation.lock().await;
        let mut store = open_store(app).await?;
        if !store.database.profiles.iter().any(|profile| profile.id == profile_id) { return Err("所选 ChatGPT 连接不存在".into()); }
        store.database.active = Some(profile_id.to_owned());
        let store = save_store(store, None).await?;
        Ok(connection(&store.database, None))
    }

    #[derive(Deserialize)]
    struct Discovery {
        issuer: String,
        authorization_endpoint: String,
        token_endpoint: String,
        jwks_uri: String,
        revocation_endpoint: Option<String>,
        #[serde(default)]
        id_token_signing_alg_values_supported: Vec<String>,
    }
    fn official_url(value: &str) -> Result<Url, String> {
        let url = Url::parse(value).map_err(|_| INVALID_IDENTITY)?;
        if url.scheme() != "https" || url.host_str() != Some("auth.openai.com")
            || url.port_or_known_default() != Some(443) || !url.username().is_empty() || url.password().is_some()
            || url.query().is_some() || url.fragment().is_some() { return Err(INVALID_IDENTITY.into()); }
        Ok(url)
    }
    fn http() -> Result<Client, String> {
        Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10)).user_agent(concat!("FastLingo/", env!("CARGO_PKG_VERSION")))
            .build().map_err(|_| NETWORK.into())
    }
    async fn bounded_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
        if response.content_length().is_some_and(|length| length > MAX_HTTP as u64) { return Err(INVALID_IDENTITY.into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK)? {
            if bytes.len() + chunk.len() > MAX_HTTP { return Err(INVALID_IDENTITY.into()); }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    async fn discovery(client: &Client) -> Result<Discovery, String> {
        let response = client.get(DISCOVERY).send().await.map_err(|_| NETWORK)?;
        if !response.status().is_success() { return Err(NETWORK.into()); }
        let value: Discovery = serde_json::from_slice(&bounded_body(response).await?).map_err(|_| INVALID_IDENTITY)?;
        if value.issuer != ISSUER || value.authorization_endpoint != AUTHORIZE || value.token_endpoint != TOKEN { return Err(INVALID_IDENTITY.into()); }
        official_url(&value.jwks_uri)?;
        if let Some(endpoint) = value.revocation_endpoint.as_ref() { official_url(endpoint)?; }
        Ok(value)
    }
    async fn jwks(client: &Client, metadata: &Discovery) -> Result<JwkSet, String> {
        let response = client.get(official_url(&metadata.jwks_uri)?).send().await.map_err(|_| NETWORK)?;
        if !response.status().is_success() { return Err(NETWORK.into()); }
        serde_json::from_slice(&bounded_body(response).await?).map_err(|_| INVALID_IDENTITY.into())
    }

    #[derive(Clone, Deserialize)]
    struct Identity {
        iss: String,
        sub: String,
        exp: u64,
        iat: u64,
        nonce: Option<String>,
        email: Option<String>,
    }
    fn verify_identity(token: &str, client_id: &str, nonce: Option<&str>, keys: &JwkSet,
        supported_algorithms: &[String]) -> Result<Identity, String> {
        if token.len() > 64 * 1024 { return Err(INVALID_IDENTITY.into()); }
        let header = decode_header(token).map_err(|_| INVALID_IDENTITY)?;
        let name = match header.alg { Algorithm::RS256 => "RS256", Algorithm::PS256 => "PS256", Algorithm::ES256 => "ES256", _ => return Err(INVALID_IDENTITY.into()) };
        if !supported_algorithms.is_empty() && !supported_algorithms.iter().any(|algorithm| algorithm == name) { return Err(INVALID_IDENTITY.into()); }
        let kid = header.kid.as_ref().filter(|value| !value.is_empty()).ok_or(INVALID_IDENTITY)?;
        let key = keys.find(kid).ok_or(INVALID_IDENTITY)?;
        let decoding_key = DecodingKey::from_jwk(key).map_err(|_| INVALID_IDENTITY)?;
        let mut validation = Validation::new(header.alg);
        validation.set_audience(&[client_id]); validation.set_issuer(&[ISSUER]);
        validation.set_required_spec_claims(&["iss", "aud", "exp", "iat", "sub"]);
        validation.leeway = 5; validation.validate_nbf = true;
        let identity = decode::<Identity>(token, &decoding_key, &validation).map_err(|_| INVALID_IDENTITY)?.claims;
        if identity.sub.is_empty() || identity.sub.len() > 512 || identity.iat > now().saturating_add(5)
            || identity.exp <= identity.iat || nonce.is_some_and(|expected| !constant_equal(identity.nonce.as_deref().unwrap_or(""), expected)) {
            return Err(INVALID_IDENTITY.into());
        }
        Ok(identity)
    }
    async fn validated_identity(client: &Client, metadata: &Discovery, token: &str, client_id: &str,
        nonce: Option<&str>) -> Result<Identity, String> {
        let keys = jwks(client, metadata).await?;
        // Fresh JWKS is fetched for each new token set, so rotation does not reuse a stale kid cache.
        verify_identity(token, client_id, nonce, &keys, &metadata.id_token_signing_alg_values_supported)
    }
    fn constant_equal(left: &str, right: &str) -> bool {
        if left.len() != right.len() { return false; }
        left.as_bytes().iter().zip(right.as_bytes()).fold(0_u8, |value, (left, right)| value | (left ^ right)) == 0
    }
    fn clean_email(value: Option<String>) -> Option<String> {
        value.filter(|value| !value.is_empty() && value.len() <= 254 && !value.chars().any(char::is_control))
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        refresh_token: Option<String>,
        id_token: Option<String>,
        token_type: String,
        expires_in: u64,
        scope: Option<String>,
        #[serde(default, deserialize_with = "optional_refresh_timestamp")]
        earliest_refresh_at: Option<u64>,
    }
    fn optional_refresh_timestamp<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
        // This optional preview field is not documented with a stable wire type.
        // Accept only a plausible absolute Unix-second integer; an unknown format
        // must not discard an otherwise valid, potentially rotated token set.
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(value.as_u64().filter(|value| (1_000_000_000..=10_000_000_000).contains(value)))
    }
    impl Drop for TokenResponse {
        fn drop(&mut self) {
            self.access_token.zeroize();
            if let Some(token) = self.refresh_token.as_mut() { token.zeroize(); }
            if let Some(token) = self.id_token.as_mut() { token.zeroize(); }
        }
    }
    enum TokenError { Permanent, TooEarly(Option<u64>), Other }
    async fn token_request(client: &Client, form: &[(&str, &str)]) -> Result<TokenResponse, TokenError> {
        let response = client.post(TOKEN).form(form).send().await.map_err(|_| TokenError::Other)?;
        let status = response.status();
        let bytes = Zeroizing::new(bounded_body(response).await.map_err(|_| TokenError::Other)?);
        if status.is_success() { return serde_json::from_slice(&bytes).map_err(|_| TokenError::Other); }
        #[derive(Deserialize)]
        struct ErrorBody {
            error: Option<serde_json::Value>,
            #[serde(default, deserialize_with = "optional_refresh_timestamp")]
            earliest_refresh_at: Option<u64>,
        }
        let parsed = serde_json::from_slice::<ErrorBody>(&bytes).ok();
        let code = parsed.as_ref().and_then(|value| value.error.as_ref()).and_then(|value| value.as_str().or_else(|| value.get("code").and_then(|value| value.as_str())));
        match code {
            Some("invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired" | "refresh_token_invalidated" | "refresh_token_reused") => Err(TokenError::Permanent),
            Some("refresh_token_too_early" | "refresh_too_early") => Err(TokenError::TooEarly(parsed.and_then(|value| value.earliest_refresh_at))),
            _ => Err(TokenError::Other),
        }
    }
    fn tokens_from_response(response: &mut TokenResponse, previous: Option<&TokenSet>, require_id: bool) -> Result<TokenSet, String> {
        if !response.token_type.eq_ignore_ascii_case("Bearer") || response.access_token.is_empty()
            || response.access_token.len() > 64 * 1024 || response.access_token.contains(['\r', '\n', '\0'])
            || response.expires_in == 0 || response.expires_in > 3600 {
            return Err(INVALID_IDENTITY.into());
        }
        let scopes = match response.scope.as_ref() {
            Some(value) => value.split_ascii_whitespace().map(str::to_owned).collect::<Vec<_>>(),
            None => previous.map(|previous| previous.scopes.clone()).ok_or(INVALID_IDENTITY)?,
        };
        if scopes.len() > 32 || scopes.iter().any(|scope| !SCOPES.split_ascii_whitespace().any(|requested| requested == scope)) { return Err(INVALID_IDENTITY.into()); }
        let refresh = response.refresh_token.take();
        if scopes.iter().any(|scope| scope == "offline_access") && refresh.as_ref().is_none_or(String::is_empty) { return Err(INVALID_IDENTITY.into()); }
        if refresh.as_ref().is_some_and(|token| token.len() > 64 * 1024 || token.contains(['\r', '\n', '\0'])) { return Err(INVALID_IDENTITY.into()); }
        let id_token = match response.id_token.take() {
            Some(token) => token,
            None if !require_id => previous.map(|previous| previous.id_token.clone()).ok_or(INVALID_IDENTITY)?,
            None => return Err(INVALID_IDENTITY.into()),
        };
        Ok(TokenSet { access_token: std::mem::take(&mut response.access_token), refresh_token: refresh,
            id_token, scopes, expires_at: now().saturating_add(response.expires_in), earliest_refresh_at: response.earliest_refresh_at })
    }

    struct OAuthValues { state: String, nonce: String, verifier: Zeroizing<String>, challenge: String }
    impl OAuthValues {
        fn new() -> Self {
            fn random() -> String { let mut bytes = [0_u8; 32]; OsRng.fill_bytes(&mut bytes); URL_SAFE_NO_PAD.encode(bytes) }
            let verifier = Zeroizing::new(random());
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            Self { state: random(), nonce: random(), verifier, challenge }
        }
    }
    fn authorization_url(host_id: &str, profile: Option<&Profile>, redirect_uri: &str, values: &OAuthValues) -> Result<Url, String> {
        let mut url = Url::parse(AUTHORIZE).map_err(|_| INVALID_IDENTITY)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("client_id", profile.map(|profile| profile.client_id.as_str()).unwrap_or(DYNAMIC_CLIENT));
            if profile.is_none() { query.append_pair("agent_name_hint", "FastLingo"); }
            query.append_pair("ext_agent_host_id", host_id).append_pair("response_type", "code")
                .append_pair("redirect_uri", redirect_uri).append_pair("scope", SCOPES).append_pair("resource", RESOURCE)
                .append_pair("state", &values.state).append_pair("nonce", &values.nonce)
                .append_pair("code_challenge_method", "S256").append_pair("code_challenge", &values.challenge);
            if let Some(profile) = profile {
                if let Some(tokens) = profile.tokens.as_ref() { query.append_pair("id_token_hint", &tokens.id_token); }
                if let Some(email) = profile.email.as_ref() { query.append_pair("login_hint", email); }
                // This button explicitly requests plan permission after an identity-only grant.
                // Do not force consent on ordinary returning sign-ins.
                if profile.tokens.as_ref().is_some_and(|tokens| !plan_enabled(tokens)) { query.append_pair("prompt", "consent"); }
            }
        }
        Ok(url)
    }
    fn open_authorization_url(url: &Url) -> Result<(), String> {
        if url.scheme() != "https" || url.host_str() != Some("auth.openai.com") || url.path() != "/api/accounts/authorize"
            || url.port_or_known_default() != Some(443) || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(INVALID_IDENTITY.into());
        }
        #[cfg(target_os = "windows")]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let root = std::env::var_os("SystemRoot").ok_or("无法打开系统浏览器")?;
            let mut command = std::process::Command::new(PathBuf::from(root).join("explorer.exe"));
            command.creation_flags(0x08000000); command
        };
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg(url.as_str()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()).spawn().map_err(|_| "无法打开系统浏览器，请检查默认浏览器设置")?;
        Ok(())
    }

    struct Callback { client_id: String, code: Zeroizing<String> }
    fn parse_callback(target: &str, state: &str, selected_client: Option<&str>) -> Result<Callback, String> {
        let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| INVALID_IDENTITY)?;
        if !target.starts_with("/auth/callback?") || url.path() != "/auth/callback" || url.fragment().is_some() { return Err(INVALID_IDENTITY.into()); }
        let mut parameters = HashMap::new();
        for (key, value) in url.query_pairs() {
            if parameters.insert(key.to_string(), value.to_string()).is_some() { return Err(INVALID_IDENTITY.into()); }
        }
        if !constant_equal(parameters.get("state").map(String::as_str).unwrap_or(""), state) { return Err(INVALID_IDENTITY.into()); }
        if let Some(error) = parameters.get("error") {
            return Err(if error == "access_denied" { "ChatGPT 授权已取消，可稍后重新登录".into() } else { "ChatGPT 未完成授权，请重新登录".into() });
        }
        let client = match (selected_client, parameters.remove("client_id")) {
            (Some(expected), Some(received)) if expected != received => return Err(INVALID_IDENTITY.into()),
            (Some(expected), _) => expected.to_owned(),
            (None, Some(received)) if valid_client(&received) => received,
            _ => return Err("ChatGPT 未返回有效的应用注册信息，请重新登录".into()),
        };
        if !valid_client(&client) { return Err(INVALID_IDENTITY.into()); }
        let code = parameters.remove("code").filter(|code| !code.is_empty() && code.len() <= 8192).ok_or(INVALID_IDENTITY)?;
        Ok(Callback { client_id: client, code: Zeroizing::new(code) })
    }
    async fn read_callback(stream: &mut TcpStream, authority: &str) -> Result<String, String> {
        let mut bytes = Zeroizing::new(Vec::new());
        loop {
            let mut chunk = [0_u8; 1024];
            let length = stream.read(&mut chunk).await.map_err(|_| INVALID_IDENTITY)?;
            if length == 0 { return Err(INVALID_IDENTITY.into()); }
            bytes.extend_from_slice(&chunk[..length]);
            if bytes.len() > 16 * 1024 { return Err(INVALID_IDENTITY.into()); }
            if bytes.windows(4).any(|value| value == b"\r\n\r\n") { break; }
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| INVALID_IDENTITY)?;
        let mut lines = text.split("\r\n");
        let first = lines.next().ok_or(INVALID_IDENTITY)?;
        let mut parts = first.split(' ');
        if parts.next() != Some("GET") { return Err(INVALID_IDENTITY.into()); }
        let target = parts.next().ok_or(INVALID_IDENTITY)?;
        if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) || parts.next().is_some() { return Err(INVALID_IDENTITY.into()); }
        let mut hosts = 0;
        for line in lines.take_while(|line| !line.is_empty()) {
            let (name, value) = line.split_once(':').ok_or(INVALID_IDENTITY)?;
            if name.eq_ignore_ascii_case("host") { hosts += 1; if value.trim() != authority { return Err(INVALID_IDENTITY.into()); } }
        }
        if hosts != 1 { return Err(INVALID_IDENTITY.into()); }
        Ok(target.to_owned())
    }
    async fn callback_response(stream: &mut TcpStream, success: bool) {
        let text = if success { "ChatGPT sign-in received. You may close this window and return to FastLingo." }
            else { "This sign-in callback was not accepted. Return to FastLingo and try again." };
        let response = format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{}", if success { "200 OK" } else { "400 Bad Request" }, text.len(), text);
        let _ = tokio::time::timeout(Duration::from_secs(1), stream.write_all(response.as_bytes())).await;
        let _ = stream.shutdown().await;
    }
    async fn listen_callback(listener: TcpListener, authority: &str, values: &OAuthValues,
        selected_client: Option<&str>) -> Result<Callback, String> {
        // Unrelated localhost requests cannot consume the attempt or keep the listener alive forever.
        for _ in 0..32 {
            let (mut stream, remote) = listener.accept().await.map_err(|_| "无法接收 ChatGPT 登录回调")?;
            if !remote.ip().is_loopback() { continue; }
            let target = tokio::time::timeout(Duration::from_secs(3), read_callback(&mut stream, authority)).await;
            let target = match target { Ok(Ok(target)) => target, _ => { callback_response(&mut stream, false).await; continue; } };
            if !target.starts_with("/auth/callback?") { callback_response(&mut stream, false).await; continue; }
            // Only a state-matching callback can finish, including explicit OAuth denial.
            let parsed_url = Url::parse(&format!("http://127.0.0.1{target}"));
            let matching_state = parsed_url.ok().is_some_and(|url| url.query_pairs().any(|(key, value)| key == "state" && constant_equal(&value, &values.state)));
            if !matching_state { callback_response(&mut stream, false).await; continue; }
            let result = parse_callback(&target, &values.state, selected_client);
            callback_response(&mut stream, result.is_ok()).await;
            return result;
        }
        Err("ChatGPT 登录回调无效，请重新登录".into())
    }

    pub async fn sign_in(app: &AppHandle, new_account: bool) -> Result<ConnectionStatus, String> {
        let state = app.state::<AuthState>();
        if state.stopping.load(Ordering::SeqCst) { return Err(CANCELLED.into()); }
        let attempt = Arc::new(Attempt::new());
        {
            let mut pending = state.pending.lock().map_err(|_| "登录状态暂不可用")?;
            if pending.as_ref().is_some_and(|previous| !previous.cancelled.load(Ordering::SeqCst)) {
                return Err("ChatGPT 登录正在进行，请先完成或取消本次登录".into());
            }
            *pending = Some(attempt.clone());
        }
        let result = run_sign_in(app, new_account, &attempt).await;
        if let Ok(mut pending) = state.pending.lock() {
            if pending.as_ref().is_some_and(|current| Arc::ptr_eq(current, &attempt)) { *pending = None; }
        }
        result
    }
    async fn run_sign_in(app: &AppHandle, new_account: bool, attempt: &Arc<Attempt>) -> Result<ConnectionStatus, String> {
        let state = app.state::<AuthState>();
        let (host_id, mut selected) = {
            let _operation = state.operation.lock().await;
            attempt.check()?;
            let store = open_store(app).await?;
            let profile = if new_account { None } else {
                store.database.active_profile().cloned().or_else(|| store.database.pending_profile.as_ref()
                    .and_then(|id| store.database.profiles.iter().find(|profile| &profile.id == id)).cloned())
            };
            let store = save_store(store, Some(attempt.clone())).await?;
            (store.database.host_id.clone(), profile)
        };
        let client = http()?;
        let metadata = attempt.run(discovery(&client)).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        for retry in 0..2 {
            attempt.check()?;
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(|_| "无法启动 ChatGPT 本机登录回调，请检查防火墙设置")?;
            let authority = format!("127.0.0.1:{}", listener.local_addr().map_err(|_| "无法启动本机登录回调")?.port());
            let redirect_uri = format!("http://{authority}/auth/callback");
            let values = OAuthValues::new();
            let url = authorization_url(&host_id, selected.as_ref(), &redirect_uri, &values)?;
            attempt.check()?;
            open_authorization_url(&url)?;
            let callback = attempt.run(async {
                tokio::time::timeout_at(deadline, listen_callback(listener, &authority, &values, selected.as_ref().map(|profile| profile.client_id.as_str())))
                    .await.map_err(|_| "ChatGPT 登录已超时，请重新登录".to_string())?
            }).await?;
            if selected.is_none() {
                let _operation = state.operation.lock().await;
                attempt.check()?;
                let mut store = open_store(app).await?;
                if store.database.profiles.len() >= 64 { return Err("保存的 ChatGPT 连接过多，请先整理已有连接".into()); }
                let existing = store.database.profiles.iter().find(|profile| profile.client_id == callback.client_id).cloned();
                let profile = existing.unwrap_or_else(|| Profile { id: Uuid::new_v4().to_string(), label: format!("连接 {}", store.database.profiles.len() + 1),
                    client_id: callback.client_id.clone(), issuer: None, subject: None, email: None, tokens: None });
                store.database.pending_profile = Some(profile.id.clone());
                if !store.database.profiles.iter().any(|saved| saved.id == profile.id) { store.database.profiles.push(profile.clone()); }
                save_store(store, Some(attempt.clone())).await?;
                selected = Some(profile);
            }
            let mut response = match attempt.run(async {
                token_request(&client, &[("grant_type", "authorization_code"), ("client_id", callback.client_id.as_str()),
                    ("code", callback.code.as_str()), ("code_verifier", values.verifier.as_str()),
                    ("redirect_uri", redirect_uri.as_str()), ("resource", RESOURCE)]).await
                    .map_err(|error| match error { TokenError::Permanent => RECONNECT.to_string(), _ => NETWORK.to_string() })
            }).await {
                Ok(response) => response,
                Err(error) if error == RECONNECT && retry == 0 => continue,
                Err(error) => return Err(error),
            };
            let id_token = response.id_token.as_deref().ok_or(INVALID_IDENTITY)?;
            let identity = attempt.run(validated_identity(&client, &metadata, id_token, &callback.client_id, Some(&values.nonce))).await?;
            let expected = selected.as_ref().ok_or(INVALID_IDENTITY)?;
            if expected.subject.as_ref().is_some_and(|subject| subject != &identity.sub)
                || expected.issuer.as_ref().is_some_and(|issuer| issuer != &identity.iss) { return Err("登录的 ChatGPT 账户与所选连接不同，请使用添加账户".into()); }
            let tokens = tokens_from_response(&mut response, None, true)?;
            let _operation = state.operation.lock().await;
            attempt.check()?;
            let mut store = open_store(app).await?;
            let profile = store.database.profiles.iter_mut().find(|profile| profile.id == expected.id && profile.client_id == callback.client_id).ok_or(INVALID_IDENTITY)?;
            // A concurrent disconnect/selection may cancel this attempt before its final atomic commit.
            attempt.check()?;
            profile.issuer = Some(identity.iss); profile.subject = Some(identity.sub);
            profile.email = clean_email(identity.email); profile.tokens = Some(tokens);
            store.database.active = Some(profile.id.clone()); store.database.pending_profile = None;
            let store = save_store(store, Some(attempt.clone())).await?;
            let message = if store.database.active_profile().and_then(|profile| profile.tokens.as_ref()).is_some_and(plan_enabled) { None }
                else { Some("已登录，但尚未允许 FastLingo 使用 ChatGPT 套餐；可在 ChatGPT 中管理应用授权".into()) };
            return Ok(connection(&store.database, message));
        }
        Err(RECONNECT.into())
    }
    pub fn cancel_sign_in(app: &AppHandle) {
        if let Some(state) = app.try_state::<AuthState>() {
            if let Ok(pending) = state.pending.lock() {
                if let Some(attempt) = pending.as_ref() { attempt.cancel(); }
            }
        }
    }
    pub fn shutdown(app: &AppHandle) {
        if let Some(state) = app.try_state::<AuthState>() { state.stopping.store(true, Ordering::SeqCst); }
        cancel_sign_in(app);
    }

    fn native_credentials(profile: &Profile) -> Result<Credentials, String> {
        let tokens = profile.tokens.as_ref().ok_or(RECONNECT)?;
        if !plan_enabled(tokens) { return Err("此 ChatGPT 连接未开启套餐使用权限，请重新授权".into()); }
        Ok(Credentials { access_token: tokens.access_token.clone(), client_id: profile.client_id.clone() })
    }
    pub async fn credentials(app: &AppHandle) -> Result<Credentials, String> { load_credentials(app, None).await }
    pub async fn invalidate_and_refresh(app: &AppHandle, failed_access_token: &str, expected_client_id: &str) -> Result<Credentials, String> {
        load_credentials(app, Some((failed_access_token, expected_client_id))).await
    }
    fn check_registration(profile: &Profile, expected_client_id: Option<&str>) -> Result<(), String> {
        if expected_client_id.is_some_and(|client_id| client_id != profile.client_id) {
            return Err("ChatGPT 账户已切换，请重新翻译".into());
        }
        Ok(())
    }
    async fn load_credentials(app: &AppHandle, failed: Option<(&str, &str)>) -> Result<Credentials, String> {
        let state = app.state::<AuthState>();
        let _operation = state.operation.lock().await;
        if state.stopping.load(Ordering::SeqCst) { return Err("应用正在退出".into()); }
        let mut store = open_store(app).await?;
        let profile = store.database.active_profile().cloned().ok_or("请先登录 ChatGPT")?;
        check_registration(&profile, failed.map(|(_, client_id)| client_id))?;
        let previous = profile.tokens.as_ref().ok_or(RECONNECT)?;
        if !plan_enabled(previous) { return Err("请先授权 FastLingo 使用 ChatGPT 套餐".into()); }
        let forced = failed.is_some_and(|(token, _)| constant_equal(token, &previous.access_token));
        if !forced && previous.expires_at > now().saturating_add(60) { return native_credentials(&profile); }
        if previous.earliest_refresh_at.is_some_and(|earliest| earliest > now()) {
            if !forced && previous.expires_at > now().saturating_add(5) { return native_credentials(&profile); }
            return Err("ChatGPT 暂不允许刷新此连接，请稍后重试或重新登录".into());
        }
        let refresh = previous.refresh_token.as_deref().ok_or(RECONNECT)?;
        let client = http()?;
        // Complete network-dependent verification setup before consuming a rotating
        // refresh token, so a JWKS/network failure cannot lose a replacement token.
        let metadata = discovery(&client).await?;
        let keys = jwks(&client, &metadata).await?;
        let mut response = match token_request(&client, &[("grant_type", "refresh_token"), ("client_id", profile.client_id.as_str()),
            ("refresh_token", refresh), ("resource", RESOURCE)]).await {
            Ok(response) => response,
            Err(TokenError::Permanent) => {
                if let Some(saved) = store.database.profiles.iter_mut().find(|saved| saved.id == profile.id) { saved.tokens = None; }
                save_store(store, None).await?;
                return Err(RECONNECT.into());
            }
            Err(TokenError::TooEarly(earliest)) => {
                if let Some(earliest) = earliest {
                    if let Some(tokens) = store.database.profiles.iter_mut().find(|saved| saved.id == profile.id).and_then(|saved| saved.tokens.as_mut()) {
                        tokens.earliest_refresh_at = Some(earliest);
                    }
                    save_store(store, None).await?;
                }
                if !forced && previous.expires_at > now().saturating_add(5) { return native_credentials(&profile); }
                return Err("ChatGPT 暂不允许刷新此连接，请稍后重试".into());
            }
            Err(TokenError::Other) => return Err(NETWORK.into()),
        };
        if let Some(id_token) = response.id_token.as_ref() {
            let identity = verify_identity(id_token, &profile.client_id, None, &keys, &metadata.id_token_signing_alg_values_supported)?;
            if profile.subject.as_deref() != Some(identity.sub.as_str()) || profile.issuer.as_deref() != Some(identity.iss.as_str()) { return Err(INVALID_IDENTITY.into()); }
        }
        let tokens = tokens_from_response(&mut response, Some(previous), false)?;
        // A response may remove plan permission; never continue using the older permission.
        let saved = store.database.profiles.iter_mut().find(|saved| saved.id == profile.id && saved.client_id == profile.client_id).ok_or(INVALID_IDENTITY)?;
        saved.tokens = Some(tokens);
        let store = save_store(store, None).await?;
        native_credentials(store.database.active_profile().ok_or(RECONNECT)?)
    }

    pub async fn disconnect(app: &AppHandle) -> Result<ConnectionStatus, String> {
        cancel_sign_in(app);
        let state = app.state::<AuthState>();
        let _operation = state.operation.lock().await;
        let mut store = open_store(app).await?;
        let profile = match store.database.active_profile().cloned() { Some(profile) => profile, None => return Ok(connection(&store.database, None)) };
        let mut revoked = true;
        if let Some(refresh) = profile.tokens.as_ref().and_then(|tokens| tokens.refresh_token.as_ref()) {
            revoked = false;
            if let Ok(client) = http() {
                if let Ok(metadata) = discovery(&client).await {
                    if let Some(endpoint) = metadata.revocation_endpoint {
                        for retry in 0..2 {
                            let response = client.post(&endpoint).form(&[("token", refresh.as_str()),
                                ("token_type_hint", "refresh_token"), ("client_id", profile.client_id.as_str())]).send().await;
                            match response {
                                Ok(response) if response.status() == reqwest::StatusCode::OK => { revoked = true; break; }
                                Ok(response) if !response.status().is_server_error() => break,
                                _ if retry == 0 => tokio::time::sleep(Duration::from_millis(500)).await,
                                _ => (),
                            }
                        }
                    }
                }
            }
        }
        if let Some(saved) = store.database.profiles.iter_mut().find(|saved| saved.id == profile.id) { saved.tokens = None; }
        let store = save_store(store, None).await?;
        Ok(connection(&store.database, if revoked { None } else {
            Some("已清除本机登录，但未能确认远程撤销。请在 ChatGPT 设置中断开 FastLingo 的连接".into())
        }))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn callback_rejects_wrong_state_duplicates_and_registration_swap() {
            assert!(parse_callback("/auth/callback?state=wrong&code=x&client_id=oaiapp_a", "expected", None).is_err());
            assert!(parse_callback("/auth/callback?state=ok&state=ok&code=x&client_id=oaiapp_a", "ok", None).is_err());
            assert!(parse_callback("/auth/callback?state=ok&code=x&client_id=oaiapp_b", "ok", Some("oaiapp_a")).is_err());
            assert!(parse_callback("/auth/callback?state=ok&code=x&client_id=dynamic_agent_client", "ok", None).is_err());
            assert!(parse_callback("/callback?state=ok&code=x&client_id=oaiapp_a", "ok", None).is_err());
            let value = parse_callback("/auth/callback?state=ok&code=x", "ok", Some("oaiapp_a")).unwrap();
            assert_eq!(value.client_id, "oaiapp_a");
            assert!(parse_callback("/auth/callback?state=ok&error=access_denied", "ok", None).err().unwrap().contains("取消"));
        }
        #[test]
        fn pkce_has_correct_entropy_and_distinct_attempt_values() {
            let first = OAuthValues::new(); let second = OAuthValues::new();
            assert_eq!(first.verifier.len(), 43);
            assert_ne!(first.state, first.nonce); assert_ne!(first.state, second.state);
            assert_eq!(first.challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(first.verifier.as_bytes())));
        }
        #[test]
        fn authorization_keeps_registration_and_host_bound_without_api_secrets() {
            let database = Database::default(); let values = OAuthValues::new();
            let url = authorization_url(&database.host_id, None, "http://127.0.0.1:1455/auth/callback", &values).unwrap();
            let parameters: HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(parameters.get("client_id").unwrap(), DYNAMIC_CLIENT);
            assert_eq!(parameters.get("agent_name_hint").unwrap(), "FastLingo");
            assert_eq!(parameters.get("ext_agent_host_id").unwrap(), &database.host_id);
            assert_eq!(parameters.get("code_challenge_method").unwrap(), "S256");
            assert!(!parameters.contains_key("client_secret"));
        }
        #[test]
        fn official_discovery_targets_cannot_redirect_credentials() {
            for url in ["http://auth.openai.com/revoke", "https://evil.example/revoke", "https://auth.openai.com.evil.example/jwks",
                "https://user@auth.openai.com/revoke", "https://auth.openai.com:8443/jwks", "https://auth.openai.com/jwks?token=secret"] {
                assert!(official_url(url).is_err());
            }
            assert!(official_url("https://auth.openai.com/.well-known/jwks.json").is_ok());
        }
        #[test]
        fn token_response_permission_is_authoritative_and_rotation_is_required() {
            let mut response: TokenResponse = serde_json::from_value(serde_json::json!({"access_token":"access", "id_token":"id",
                "token_type":"Bearer", "expires_in":3600, "scope":"openid email"})).unwrap();
            let tokens = tokens_from_response(&mut response, None, true).unwrap();
            assert!(!plan_enabled(&tokens));
            let mut response: TokenResponse = serde_json::from_value(serde_json::json!({"access_token":"access", "id_token":"id",
                "token_type":"Bearer", "expires_in":3600, "scope":SCOPES})).unwrap();
            assert!(tokens_from_response(&mut response, None, true).is_err());
        }
        #[test]
        fn optional_preview_metadata_cannot_discard_a_rotated_token_set() {
            for metadata in [serde_json::Value::Null, serde_json::json!("future-format"), serde_json::json!({"time":"unknown"}),
                serde_json::json!(1792000000000_u64), serde_json::json!(-1)] {
                let response: TokenResponse = serde_json::from_value(serde_json::json!({"access_token":"synthetic", "id_token":"synthetic",
                    "token_type":"Bearer", "expires_in":3600, "scope":"openid email", "earliest_refresh_at":metadata})).unwrap();
                assert!(response.earliest_refresh_at.is_none());
            }
        }
        #[test]
        fn id_token_signature_and_identity_claims_are_all_required() {
            use jsonwebtoken::{encode, EncodingKey, Header};
            // A freshly generated, synthetic P-256 fixture; this key never represented a user or service.
            let private_der = base64::engine::general_purpose::STANDARD.decode("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgyGeeZX8k9AFuYE8AtxlzkNfy4igG1b+vAK4lT+y5pWShRANCAASnUH5e2U38pug1yFYUCsxUahLIHMUia3h7MIu/i1isaF5qg4WBb9QSZ2veJAV4PWN1M9ssetFipX0s5zZ25KWd").unwrap();
            let keys: JwkSet = serde_json::from_value(serde_json::json!({"keys":[{"kty":"EC","kid":"synthetic",
                "crv":"P-256","x":"p1B-XtlN_KboNchWFArMVGoSyBzFImt4ezCLv4tYrGg","y":"XmqDhYFv1BJna94kBXg9Y3Uz2yx60WKlfSznNnbkpZ0"}]})).unwrap();
            let mut header = Header::new(Algorithm::ES256); header.kid = Some("synthetic".into());
            let encoding = EncodingKey::from_ec_der(&private_der);
            let claims = serde_json::json!({"iss":ISSUER,"sub":"synthetic-account","aud":"oaiapp_test",
                "exp":now()+3600,"iat":now(),"nonce":"expected","email":"test@example.invalid"});
            let signed = encode(&header, &claims, &encoding).unwrap();
            assert!(verify_identity(&signed, "oaiapp_test", Some("expected"), &keys, &["ES256".into()]).is_ok());
            assert!(verify_identity(&signed, "oaiapp_other", Some("expected"), &keys, &[]).is_err());
            assert!(verify_identity(&signed, "oaiapp_test", Some("wrong"), &keys, &[]).is_err());
            for (name, value) in [("iss", serde_json::json!("https://evil.example")), ("exp", serde_json::json!(now()-60)),
                ("iat", serde_json::json!(now()+60)), ("sub", serde_json::json!(""))] {
                let mut invalid = claims.clone(); invalid[name] = value;
                let token = encode(&header, &invalid, &encoding).unwrap();
                assert!(verify_identity(&token, "oaiapp_test", Some("expected"), &keys, &[]).is_err());
            }
            let mut unknown_kid = header.clone(); unknown_kid.kid = Some("untrusted".into());
            let token = encode(&unknown_kid, &claims, &encoding).unwrap();
            assert!(verify_identity(&token, "oaiapp_test", Some("expected"), &keys, &[]).is_err());
            let token = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(b"forged")).unwrap();
            assert!(verify_identity(&token, "oaiapp_test", Some("expected"), &keys, &[]).is_err());
        }
        #[test]
        fn credentials_are_encrypted_and_authenticated_against_corruption() {
            let key = [7_u8;32]; let nonce = [8_u8;12];
            let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
            let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: b"synthetic-access-and-refresh", aad: AAD }).unwrap();
            assert!(!encrypted.windows(9).any(|bytes| bytes == b"synthetic"));
            let mut corrupted = encrypted.clone(); corrupted[0] ^= 1;
            assert!(cipher.decrypt(Nonce::from_slice(&nonce), Payload {msg:&corrupted,aad:AAD}).is_err());
            assert!(cipher.decrypt(Nonce::from_slice(&nonce), Payload {msg:&encrypted,aad:b"other-app"}).is_err());
        }
        #[test]
        fn failed_requests_cannot_silently_retry_with_a_different_account() {
            let profile = Profile { id: Uuid::new_v4().to_string(), label:"连接 B".into(), client_id:"oaiapp_b".into(),
                issuer:Some(ISSUER.into()), subject:Some("account-b".into()), email:None, tokens:None };
            assert!(check_registration(&profile, Some("oaiapp_a")).is_err());
            assert!(check_registration(&profile, Some("oaiapp_b")).is_ok());
        }
        #[test]
        fn cancellation_and_disk_commit_have_a_single_ordering_point() {
            let attempt = Arc::new(Attempt::new());
            let directory = std::env::temp_dir().join(format!("fastlingo-siwc-test-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let path = directory.join("synthetic.enc");
            let worker_attempt = attempt.clone(); let worker_path = path.clone();
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || worker_attempt.commit(|| {
                entered_tx.send(()).unwrap(); release_rx.recv().unwrap();
                atomic_write(&worker_path, b"synthetic committed record")
            }));
            entered_rx.recv().unwrap();
            let cancel_attempt = attempt.clone();
            let (cancel_tx, cancel_rx) = std::sync::mpsc::channel();
            let cancel = std::thread::spawn(move || { cancel_attempt.cancel(); cancel_tx.send(()).unwrap(); });
            let cancellation_waited = cancel_rx.recv_timeout(Duration::from_millis(30)).is_err();
            release_tx.send(()).unwrap(); worker.join().unwrap().unwrap(); cancel.join().unwrap();
            assert!(cancellation_waited);
            assert!(attempt.commit(|| atomic_write(&path, b"late write")).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"synthetic committed record");
            fs::remove_file(&path).unwrap(); fs::remove_dir(&directory).unwrap();
        }
        #[tokio::test]
        async fn cancellation_drops_loopback_listener_immediately() {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let attempt = Arc::new(Attempt::new()); let cancel = attempt.clone();
            let values = OAuthValues::new();
            let task = tokio::spawn(async move { attempt.run(listen_callback(listener, &address.to_string(), &values, None)).await });
            cancel.cancel();
            assert!(task.await.unwrap().is_err());
            assert!(TcpListener::bind(address).await.is_ok());
        }
    }
}
