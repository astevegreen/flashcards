//! OS keychain storage for sign-in secrets (Windows Credential Manager, macOS Keychain,
//! Linux Secret Service).
//!
//! The WebView can only reach entries under the fixed service name below, and only for the
//! account names in `ALLOWED_ACCOUNTS`, so page script cannot read other apps' secrets.

use keyring::{Entry, Error};

const SERVICE: &str = "app.flashcards.localfirst";
// Keep in sync with the `account:` names in packages/platform-tauri/src/native/boot.ts
// (checked by packages/platform-tauri/tests/secure-store-accounts.test.ts).
const ALLOWED_ACCOUNTS: &[&str] = &[
    "google-refresh-token",
    "microsoft-refresh-token",
    "dropbox-refresh-token",
];
const PROBE_ACCOUNT: &str = "secure-store-probe";

fn entry(account: &str) -> Result<Entry, String> {
    if !ALLOWED_ACCOUNTS.contains(&account) {
        return Err(format!("unknown secure-store account \"{account}\""));
    }
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn available() -> bool {
    let Ok(probe) = Entry::new(SERVICE, PROBE_ACCOUNT) else {
        return false;
    };
    matches!(probe.get_password(), Ok(_) | Err(Error::NoEntry))
}

fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn set(account: &str, secret: &str) -> Result<(), String> {
    entry(account)?
        .set_password(secret)
        .map_err(|e| e.to_string())
}

fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// The commands are async and do the keychain call on a blocking-pool thread. A synchronous
// command runs on the main thread, so a keychain that waits for an unlock prompt (macOS, a
// locked GNOME Keyring) froze the window at boot (N7).

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// True when the OS has a usable secret store. On Linux this is false without a running
/// Secret Service (e.g. no GNOME Keyring / KWallet), and the app then falls back to SQLite.
#[tauri::command]
pub async fn secure_store_available() -> bool {
    blocking(|| Ok(available())).await.unwrap_or(false)
}

#[tauri::command]
pub async fn secure_store_get(account: String) -> Result<Option<String>, String> {
    blocking(move || get(&account)).await
}

#[tauri::command]
pub async fn secure_store_set(account: String, secret: String) -> Result<(), String> {
    blocking(move || set(&account, &secret)).await
}

#[tauri::command]
pub async fn secure_store_delete(account: String) -> Result<(), String> {
    blocking(move || delete(&account)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    use tauri::async_runtime::block_on;

    #[test]
    fn rejects_unknown_accounts() {
        assert!(block_on(secure_store_get("someone-else".into())).is_err());
        assert!(block_on(secure_store_set("someone-else".into(), "x".into())).is_err());
        assert!(block_on(secure_store_delete("someone-else".into())).is_err());
    }

    #[test]
    fn keychain_work_runs_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = block_on(blocking(|| Ok(std::thread::current().id()))).unwrap();
        assert_ne!(worker, caller);
    }

    #[test]
    fn a_panicking_keychain_call_becomes_an_error() {
        let result: Result<(), String> = block_on(blocking(|| panic!("keychain crashed")));
        assert!(result.is_err());
    }

    /// Round-trips a value through the real OS keychain. Run with
    /// `cargo test -- --ignored` on a machine with a keychain; it uses the real account name,
    /// so do not run it while signed in to the desktop app.
    #[test]
    #[ignore]
    fn round_trips_through_os_keychain() {
        assert!(block_on(secure_store_available()));
        let account = "google-refresh-token".to_string();
        let get = || block_on(secure_store_get(account.clone())).unwrap();
        block_on(secure_store_set(account.clone(), "test-secret-1".into())).unwrap();
        assert_eq!(get().as_deref(), Some("test-secret-1"));
        block_on(secure_store_set(account.clone(), "test-secret-2".into())).unwrap();
        assert_eq!(get().as_deref(), Some("test-secret-2"));
        block_on(secure_store_delete(account.clone())).unwrap();
        assert_eq!(get(), None);
        block_on(secure_store_delete(account.clone())).unwrap();
    }
}
