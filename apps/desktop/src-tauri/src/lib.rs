//! Tauri v2 desktop shell (§10.1, §15 Phase 8).
//!
//! Wraps the identical `apps/web/dist` bundle. All app logic lives in TypeScript
//! (`@flash/platform-tauri/native`); this crate only registers the plugins it calls:
//! SQLite storage, filesystem + watcher, dialogs, `flashcards://` deep links, the system
//! browser opener, Rust-side HTTP (OAuth token exchange) and the loopback OAuth server.
//! The only app-defined commands are the OS keychain accessors in `secure_store`.

mod secure_store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered first: forwards `flashcards://picker-callback` launches from a second
    // process to the running instance, where tauri-plugin-deep-link emits them to `onOpenUrl`.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_oauth::init())
        .invoke_handler(tauri::generate_handler![
            secure_store::secure_store_available,
            secure_store::secure_store_get,
            secure_store::secure_store_set,
            secure_store::secure_store_delete,
        ])
        .setup(|app| {
            // Installers register the scheme on Windows/Linux; dev and portable runs need it at runtime.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("deep-link registration failed: {err}");
                }
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flashcards desktop shell");
}
