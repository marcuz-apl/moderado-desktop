//! Browser sign-in for the Moderado account.
//!
//! The Gateway publishes an OAuth 2.0 authorization-code flow with PKCE and a
//! loopback redirect (`docs/CONTRACT.md`). Signing in here mints the same
//! revocable 30-day key the provider layer uses, and returns the account email
//! so the User pane can name the signed-in person.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const AUTHORIZE_ENDPOINT: &str = "https://modr.alfazen.org/authorize";
const TOKEN_ENDPOINT: &str = "https://modr.alfazen.org/oauth/token";
const CLIENT_ID: &str = "moderado-desktop";
const KEYCHAIN_SERVICE: &str = "com.moderado.desktop";
/// The same keychain entry the provider layer reads, so the key applies at once.
const KEYCHAIN_ACCOUNT: &str = "https://modr.alfazen.org/v1";
/// The Gateway keeps the authorization code for five minutes.
const WAIT_LIMIT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Serialize, Deserialize)]
pub struct AccountIdentity {
    pub email: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    email: Option<String>,
}

/// Opens the Gateway consent page and waits for its loopback callback.
#[tauri::command]
pub async fn moderado_sign_in(app: tauri::AppHandle) -> Result<AccountIdentity, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not open a loopback port for sign-in".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not read the loopback port".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token(32)?;
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_token(24)?;
    let authorize = reqwest::Url::parse_with_params(
        AUTHORIZE_ENDPOINT,
        &[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
        ],
    )
    .map_err(|_| "Could not build the sign-in URL".to_string())?;
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|_| "Could not open the browser for sign-in".to_string())?;
    let expected_state = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, &expected_state))
        .await
        .map_err(|_| "Sign-in task failed".to_string())??;
    exchange_code(code, verifier, redirect_uri).await
}

/// Forgets the stored key; the account itself stays intact on the website.
#[tauri::command]
pub async fn moderado_sign_out() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .map_err(|_| "Could not access the OS keychain".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the account key from the OS keychain".to_string()),
        }
    })
    .await
    .map_err(|_| "Keychain task failed".to_string())?
}

async fn exchange_code(
    code: String,
    verifier: String,
    redirect_uri: String,
) -> Result<AccountIdentity, String> {
    let response = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({
            "code": code,
            "verifier": verifier,
            "client_id": CLIENT_ID,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .map_err(|_| "Could not reach the Moderado Gateway".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The Gateway rejected the sign-in ({})",
            response.status()
        ));
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| "The Gateway returned an unreadable token".to_string())?;
    let email = token
        .email
        .filter(|value| !value.trim().is_empty())
        .ok_or("The Gateway did not return the account email")?;
    let api_key = token.access_token;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .map_err(|_| "Could not access the OS keychain".to_string())?;
        entry
            .set_password(&api_key)
            .map_err(|_| "Could not save the account key to the OS keychain".to_string())
    })
    .await
    .map_err(|_| "Keychain task failed".to_string())??;
    Ok(AccountIdentity { email })
}

fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + WAIT_LIMIT;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not listen for the sign-in callback".to_string())?;
    loop {
        match listener.accept() {
            Ok((mut socket, _)) => {
                socket.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut request = [0u8; 8192];
                let read = socket.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]);
                let target = head.lines().next().and_then(request_target);
                match target {
                    Some(target) if target.starts_with("/callback") => {
                        match callback_code(target, expected_state) {
                            Ok(code) => {
                                reply(&mut socket, true);
                                return Ok(code);
                            }
                            Err(reason) => {
                                reply(&mut socket, false);
                                return Err(reason);
                            }
                        }
                    }
                    // Browsers ask for /favicon.ico on their own; it must not end the wait.
                    _ => reply(&mut socket, true),
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Sign-in timed out. Try again.".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err("Could not listen for the sign-in callback".to_string()),
        }
    }
}

/// Reads `GET /path?query HTTP/1.1` down to its request target.
fn request_target(line: &str) -> Option<&str> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next()
}

fn callback_code(target: &str, expected_state: &str) -> Result<String, String> {
    let Some((path, query)) = target.split_once('?') else {
        return Err("The sign-in callback had no result".to_string());
    };
    if path != "/callback" {
        return Err("Unexpected sign-in callback".to_string());
    }
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        match name {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => return Err(format!("Authorization was not granted ({value})")),
            _ => {}
        }
    }
    if state != Some(expected_state) {
        return Err("The sign-in response did not match this request. Try again.".to_string());
    }
    code.filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "The sign-in callback had no code".to_string())
}

fn reply(socket: &mut TcpStream, signed_in: bool) {
    let (status, message) = if signed_in {
        ("200 OK", "Signed in. You can close this tab and return to Moderado Desktop.")
    } else {
        ("400 Bad Request", "Sign-in failed. Close this tab and try again from Moderado Desktop.")
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Moderado Desktop</title><p>{message}</p>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes());
}

fn random_token(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer)
        .map_err(|_| "Could not generate the sign-in secret".to_string())?;
    Ok(base64url(&buffer))
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let bits = (first << 16) | (second << 8) | third;
        out.push(ALPHABET[((bits >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((bits >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((bits >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(bits & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7636, Appendix B.
    #[test]
    fn the_challenge_matches_the_published_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            base64url(&Sha256::digest(verifier.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_32_byte_secret_fits_the_gateway_length_rules() {
        let token = random_token(32).unwrap();
        assert_eq!(token.len(), 43);
        assert!(token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    }

    #[test]
    fn the_callback_keeps_the_code_only_for_the_matching_state() {
        assert_eq!(
            callback_code("/callback?code=abc123&state=xyz", "xyz").unwrap(),
            "abc123"
        );
        assert!(callback_code("/callback?code=abc123&state=other", "xyz").is_err());
        assert!(callback_code("/callback?error=access_denied&state=xyz", "xyz").is_err());
        assert!(callback_code("/callback?state=xyz", "xyz").is_err());
        assert!(callback_code("/favicon.ico", "xyz").is_err());
    }

    #[test]
    fn only_a_get_request_line_yields_a_target() {
        assert_eq!(request_target("GET /callback?code=a HTTP/1.1"), Some("/callback?code=a"));
        assert_eq!(request_target("POST /callback HTTP/1.1"), None);
        assert_eq!(request_target(""), None);
    }
}
