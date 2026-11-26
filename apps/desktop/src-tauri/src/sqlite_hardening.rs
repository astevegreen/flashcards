//! SQLite hardening for the app database (N9).
//!
//! The Capacitor shell runs `PRAGMA secure_delete = ON` on its one connection. tauri-plugin-sql
//! opens an sqlx pool instead, and a pragma sent from TypeScript reaches only whichever pooled
//! connection happens to run it. So the bundled SQLite itself is compiled with
//! `SQLITE_SECURE_DELETE` (`apps/desktop/.cargo/config.toml` sets `LIBSQLITE3_FLAGS` for
//! libsqlite3-sys): every connection any pool opens then starts with `secure_delete = ON`, and
//! deleted rows (such as a refresh token moved to the keychain) are overwritten with zeros.

use std::ffi::CString;

/// True when the linked SQLite was compiled with `SQLITE_SECURE_DELETE`.
pub fn secure_delete_by_default() -> bool {
    let option = CString::new("SECURE_DELETE").expect("no NUL in a literal");
    // SAFETY: `option` is a valid NUL-terminated C string that outlives the call, and
    // `sqlite3_compileoption_used` only reads it.
    unsafe { libsqlite3_sys::sqlite3_compileoption_used(option.as_ptr()) == 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    use tauri::async_runtime::block_on;

    #[test]
    fn bundled_sqlite_is_compiled_with_secure_delete() {
        assert!(
            secure_delete_by_default(),
            "libsqlite3-sys was built without SQLITE_SECURE_DELETE; check apps/desktop/.cargo/config.toml"
        );
    }

    /// Opens several connections of one sqlx pool at once (as tauri-plugin-sql does) and checks
    /// that each of them, not just the first, has `secure_delete` on.
    #[test]
    fn every_pooled_connection_has_secure_delete_on() {
        let dir = std::env::temp_dir().join(format!("flash-secure-delete-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(4)
                .min_connections(4)
                .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true))
                .await
                .unwrap();
            let mut held = Vec::new();
            for _ in 0..4 {
                held.push(pool.acquire().await.unwrap());
            }
            for conn in held.iter_mut() {
                let row = sqlx::query("PRAGMA secure_delete")
                    .fetch_one(&mut **conn)
                    .await
                    .unwrap();
                assert_eq!(row.get::<i64, _>(0), 1);
            }
            drop(held);
            pool.close().await;
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
