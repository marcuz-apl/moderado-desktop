//! API keys, filed in the OS keychain.
//!
//! The account used to be the provider's base URL, so editing the endpoint
//! orphaned the saved secret: the keychain still held it under the old URL while
//! the new one looked unconfigured, and every endpoint the user had ever typed
//! left another dead entry behind. Keys are now keyed by provider — one provider
//! has one endpoint — so the endpoint can move without losing the key. Reading
//! migrates a secret that is still filed under the old URL.

use crate::provider::ProviderId;

const SERVICE: &str = "com.moderado.desktop";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|_| "Could not access OS keychain".to_owned())
}

pub fn save(provider_id: ProviderId, base_url: &str, api_key: &str) -> Result<(), String> {
    entry(provider_id.slug())?
        .set_password(api_key)
        .map_err(|_| "Could not save API key to OS keychain".to_owned())?;
    // Drop a secret left by the URL-keyed scheme so the keychain does not keep
    // one dead entry per endpoint.
    if let Ok(legacy) = entry(base_url) {
        let _ = legacy.delete_credential();
    }
    Ok(())
}

pub fn read(provider_id: ProviderId, base_url: &str) -> Result<String, String> {
    match entry(provider_id.slug())?.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => migrate(provider_id, base_url),
        Err(_) => Err("Could not read API key from OS keychain".to_owned()),
    }
}

/// Re-files a secret found under the old URL-keyed account so it survives the
/// next endpoint change. A keychain with nothing in it is not an error: the
/// caller treats an empty string as "not configured".
fn migrate(provider_id: ProviderId, base_url: &str) -> Result<String, String> {
    let value = match entry(base_url)?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(String::new()),
        Err(_) => return Err("Could not read API key from OS keychain".to_owned()),
    };
    if value.is_empty() {
        return Ok(String::new());
    }
    save(provider_id, base_url, &value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_gets_its_own_account() {
        let accounts: std::collections::BTreeSet<&str> =
            crate::provider::PRESETS.iter().map(|preset| preset.id.slug()).collect();
        assert_eq!(accounts.len(), crate::provider::PRESETS.len(), "provider slugs must be unique");
        assert!(accounts.iter().all(|slug| !slug.is_empty()));
    }

    #[test]
    fn account_is_not_the_base_url() {
        // The regression this module exists to prevent.
        let preset = ProviderId::OpenAiCompatible.preset();
        assert_ne!(ProviderId::OpenAiCompatible.slug(), preset.default_base_url);
        assert!(!ProviderId::OpenAiCompatible.slug().contains("://"));
    }
}
