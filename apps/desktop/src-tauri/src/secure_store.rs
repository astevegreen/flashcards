//! OS keychain storage for sign-in secrets (Windows Credential Manager, macOS Keychain,
//! Linux Secret Service).
//!
//! The WebView can only reach entries under the fixed service name below, and only for the
//! account names in `ALLOWED_ACCOUNTS`, so page script cannot read other apps' secrets.

use keyring::{Entry, Error};

const SERVICE: &str = "app.flashcards.localfirst";
const ALLOWED_ACCOUNTS: &[&str] = &["google-refresh-token"];
const PROBE_ACCOUNT: &str = "secure-store-probe";

fn entry(account: &str) -> Result<Entry, String> {
    if !ALLOWED_ACCOUNTS.contains(&account) {
        return Err(format!("unknown secure-store account \"{account}\""));
    }
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// True when the OS has a usable secret store. On Linux this is false without a running
/// Secret Service (e.g. no GNOME Keyring / KWallet), and the app then falls back to SQLite.
#[tauri::command]
pub fn secure_store_available() -> bool {
    let Ok(probe) = Entry::new(SERVICE, PROBE_ACCOUNT) else {
        return false;
    };
    matches!(probe.get_password(), Ok(_) | Err(Error::NoEntry))
}

#[tauri::command]
pub fn secure_store_get(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secure_store_set(account: String, secret: String) -> Result<(), String> {
    entry(&account)?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secure_store_delete(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_accounts() {
        assert!(secure_store_get("someone-else".into()).is_err());
        assert!(secure_store_set("someone-else".into(), "x".into()).is_err());
        assert!(secure_store_delete("someone-else".into()).is_err());
    }

    /// Round-trips a value through the real OS keychain. Run with
    /// `cargo test -- --ignored` on a machine with a keychain; it uses the real account name,
    /// so do not run it while signed in to the desktop app.
    #[test]
    #[ignore]
    fn round_trips_through_os_keychain() {
        assert!(secure_store_available());
        let account = "google-refresh-token".to_string();
        secure_store_set(account.clone(), "test-secret-1".into()).unwrap();
        assert_eq!(
            secure_store_get(account.clone()).unwrap().as_deref(),
            Some("test-secret-1")
        );
        secure_store_set(account.clone(), "test-secret-2".into()).unwrap();
        assert_eq!(
            secure_store_get(account.clone()).unwrap().as_deref(),
            Some("test-secret-2")
        );
        secure_store_delete(account.clone()).unwrap();
        assert_eq!(secure_store_get(account.clone()).unwrap(), None);
        secure_store_delete(account).unwrap();
    }
}
