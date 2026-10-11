use super::{list_models, ProviderId};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub provider_id: ProviderId,
    pub base_url: String,
    pub plan_model: String,
    pub act_model: String,
}

pub fn load(path: &Path) -> Result<Option<ProviderSettings>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read provider settings: {error}")),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid provider settings file".into())
}

pub async fn save(
    path: &Path,
    mut settings: ProviderSettings,
    key: &str,
) -> Result<ProviderSettings, String> {
    settings.base_url = settings.provider_id.base_url(&settings.base_url)?;
    if settings.plan_model.trim().is_empty() || settings.act_model.trim().is_empty() {
        return Err("Select both Plan and Act models before saving".into());
    }
    if settings.plan_model.len() > 200 || settings.act_model.len() > 200 {
        return Err("Model name is too long".into());
    }
    if settings.provider_id == ProviderId::Custom
        && list_models(&settings.base_url, key).await?.is_empty()
    {
        return Err("Custom endpoint returned no models".into());
    }
    let parent = path.parent().ok_or("Invalid provider settings path")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create settings folder: {error}"))?;
    let bytes =
        serde_json::to_vec_pretty(&settings).map_err(|_| "Could not encode provider settings")?;
    fs::write(path, bytes).map_err(|error| format!("Could not save provider settings: {error}"))?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn custom_endpoint_is_checked_before_settings_are_saved() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /v1/models"));
            let body = r#"{"data":[{"id":"test-model"}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        });
        let settings = ProviderSettings {
            provider_id: ProviderId::Custom,
            base_url,
            plan_model: "test-model".into(),
            act_model: "test-model".into(),
        };
        save(&path, settings, "secret-only-in-keychain")
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(
            load(&path).unwrap().unwrap().provider_id,
            ProviderId::Custom
        );
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("secret-only-in-keychain"));
    }

    #[tokio::test]
    async fn invalid_custom_endpoint_is_not_saved() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let settings = ProviderSettings {
            provider_id: ProviderId::Custom,
            base_url: "http://example.com/v1".into(),
            plan_model: "one".into(),
            act_model: "two".into(),
        };
        assert!(save(&path, settings, "").await.is_err());
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_settings_report_an_error() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        fs::write(&path, b"{incomplete").unwrap();
        assert!(load(&path)
            .unwrap_err()
            .contains("Invalid provider settings"));
    }
}
