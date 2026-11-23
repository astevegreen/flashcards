//! iCloud Drive file I/O for the macOS build, behind `ICloudDriveSyncTransport`
//! (`packages/platform-capacitor/src/sync/icloud-transport.ts`, adapted for Tauri in
//! `packages/platform-tauri/src/sync/tauri-icloud-bridge.ts`).
//!
//! Same container and layout as the iOS plugin (`apps/mobile/ios/App/App/ICloudDocumentsPlugin.swift`):
//! sync files live at `<container root>/<relative sync path>`, outside `Documents/`, so an iPhone
//! and a Mac signed in to the same Apple ID share one collection without it showing up in Finder.
//!
//! Failures carry the `SyncTransportError` codes the sync engine understands (`NOT_FOUND`,
//! `ALREADY_EXISTS`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `NETWORK`, else `UNKNOWN`).
//!
//! On Windows and Linux there is no container, so `icloud_available` is false and every other
//! command fails with `AUTH_REQUIRED`. The file logic itself is plain `std::fs` and is unit-tested
//! on every platform against a temporary folder.

use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Must match the iOS entitlement (`App.entitlements`) so both apps open the same container.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CONTAINER_ID: &str = "iCloud.app.flashcards.localfirst";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct IcloudError {
    pub code: &'static str,
    pub message: String,
}

impl IcloudError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn unavailable() -> Self {
        Self::new(
            "AUTH_REQUIRED",
            "iCloud Drive is not available. Sign in to iCloud in System Settings and turn on iCloud Drive.",
        )
    }

    fn io(err: &io::Error, path: &str) -> Self {
        let code = match err.kind() {
            io::ErrorKind::NotFound => "NOT_FOUND",
            io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
            io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            _ => "UNKNOWN",
        };
        Self::new(code, format!("iCloud Drive error for \"{path}\": {err}"))
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Joins a relative sync path onto the root, refusing `..`, `.`, NUL, empty paths and anything
/// that is not a plain file name on this OS (drive letters, roots).
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, IcloudError> {
    let unsafe_path = || {
        IcloudError::new(
            "UNKNOWN",
            format!("Unsafe iCloud Drive sync path \"{relative}\""),
        )
    };
    let normalized = relative.replace('\\', "/");
    if normalized.contains('\0') {
        return Err(unsafe_path());
    }
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(unsafe_path());
    }
    let mut out = root.to_path_buf();
    for part in parts {
        let mut components = Path::new(part).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) if name == part => out.push(name),
            _ => return Err(unsafe_path()),
        }
    }
    Ok(out)
}

/// Older macOS versions stand in for a file not downloaded yet with a hidden `.<name>.icloud` file.
fn placeholder_target(name: &str) -> Option<&str> {
    name.strip_prefix('.')?
        .strip_suffix(".icloud")
        .filter(|n| !n.is_empty())
}

pub fn placeholder_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.icloud"))
}

pub fn exists_locally_or_in_cloud(path: &Path) -> bool {
    path.exists() || placeholder_path(path).exists()
}

fn millis(meta: &fs::Metadata) -> Option<f64> {
    let since = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((since.as_secs_f64() * 1000.0).round())
}

// ---------------------------------------------------------------------------
// Listing, reading and writing (platform-independent)
// ---------------------------------------------------------------------------

/// Every file under `root` whose relative path starts with `prefix`, sorted by path. Hidden files
/// are skipped (like the iOS walker), except iCloud placeholders, which stand for their file.
pub fn list_files(root: &Path, prefix: &str) -> Result<Vec<FileEntry>, IcloudError> {
    let mut found: std::collections::BTreeMap<String, (FileEntry, bool)> = Default::default();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel_dir)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(IcloudError::io(&err, prefix)),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let join = |n: &str| {
                if rel_dir.is_empty() {
                    n.to_string()
                } else {
                    format!("{rel_dir}/{n}")
                }
            };
            if file_type.is_dir() {
                if !name.starts_with('.') {
                    stack.push((entry.path(), join(&name)));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let (rel, is_placeholder) = match placeholder_target(&name) {
                Some(target) => (join(target), true),
                None if name.starts_with('.') => continue,
                None => (join(&name), false),
            };
            if !rel.starts_with(prefix) {
                continue;
            }
            let meta = entry.metadata().ok();
            let file = FileEntry {
                path: rel.clone(),
                // A placeholder's own size is not the file's size; it is unknown until downloaded.
                size: if is_placeholder {
                    0
                } else {
                    meta.as_ref().map_or(0, |m| m.len())
                },
                updated_at: meta.as_ref().and_then(millis),
            };
            // The real file wins over its placeholder.
            match found.get(&rel) {
                Some((_, false)) => {}
                _ => {
                    found.insert(rel, (file, is_placeholder));
                }
            }
        }
    }
    Ok(found.into_values().map(|(f, _)| f).collect())
}

pub fn read_file(
    root: &Path,
    relative: &str,
    ensure_downloaded: impl Fn(&Path) -> Result<(), IcloudError>,
) -> Result<Vec<u8>, IcloudError> {
    let path = resolve(root, relative)?;
    if !exists_locally_or_in_cloud(&path) {
        return Err(IcloudError::new(
            "NOT_FOUND",
            format!("iCloud Drive sync file not found: \"{relative}\""),
        ));
    }
    ensure_downloaded(&path)?;
    fs::read(&path).map_err(|e| IcloudError::io(&e, relative))
}

/// With `if_absent`, an exclusive create that fails with `ALREADY_EXISTS` (also when only the
/// placeholder of a file written on another device is here). Otherwise an atomic replace.
pub fn write_file(
    root: &Path,
    relative: &str,
    data: &[u8],
    if_absent: bool,
) -> Result<(), IcloudError> {
    let path = resolve(root, relative)?;
    let io_err = |e: io::Error| IcloudError::io(&e, relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }
    if if_absent {
        if exists_locally_or_in_cloud(&path) {
            return Err(IcloudError::new(
                "ALREADY_EXISTS",
                format!("iCloud Drive write-once file already exists: \"{relative}\""),
            ));
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| match e.kind() {
                io::ErrorKind::AlreadyExists => IcloudError::new(
                    "ALREADY_EXISTS",
                    format!("iCloud Drive write-once file already exists: \"{relative}\""),
                ),
                _ => io_err(e),
            })?;
        file.write_all(data)
            .and_then(|()| file.sync_all())
            .map_err(io_err)?;
        return Ok(());
    }
    // Hidden temp file next to the target (never listed), then rename over it.
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = path.with_file_name(format!(".{name}.{}-{nanos}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(io_err)
}

// ---------------------------------------------------------------------------
// The container (macOS only)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod apple {
    use super::{placeholder_path, IcloudError, CONTAINER_ID};
    use objc2_foundation::{
        NSArray, NSError, NSFileManager, NSString, NSURLUbiquitousItemDownloadingErrorKey,
        NSURLUbiquitousItemDownloadingStatusCurrent, NSURLUbiquitousItemDownloadingStatusKey,
        NSURL,
    };
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    static CACHED_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

    /// The container root, or `None` when the user is signed out of iCloud, iCloud Drive is off,
    /// or the build lacks the iCloud entitlement. Blocks, so never call it on the main thread.
    pub fn container_root() -> Option<PathBuf> {
        objc2::rc::autoreleasepool(|_| {
            let fm = NSFileManager::defaultManager();
            let mut cached = CACHED_ROOT.lock().unwrap_or_else(|e| e.into_inner());
            if fm.ubiquityIdentityToken().is_none() {
                *cached = None;
                return None;
            }
            if let Some(root) = cached.as_ref() {
                return Some(root.clone());
            }
            let id = NSString::from_str(CONTAINER_ID);
            let root = fm
                .URLForUbiquityContainerIdentifier(Some(&id))?
                .to_file_path()?;
            *cached = Some(root.clone());
            Some(root)
        })
    }

    /// A fresh `NSURL` each time, so no cached resource values.
    fn resource(
        path: &Path,
        key: &NSString,
    ) -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
        let url = NSURL::from_file_path(path)?;
        let keys = NSArray::from_slice(&[key]);
        url.resourceValuesForKeys_error(&keys)
            .ok()?
            .objectForKey(key)
    }

    fn download_is_current(path: &Path) -> bool {
        // SAFETY: Foundation constants, valid for the life of the process.
        let (key, current) = unsafe {
            (
                NSURLUbiquitousItemDownloadingStatusKey,
                NSURLUbiquitousItemDownloadingStatusCurrent,
            )
        };
        match resource(path, key).and_then(|v| v.downcast::<NSString>().ok()) {
            Some(status) => status.isEqualToString(current),
            // No iCloud status: a plain local file, unless a placeholder says it is still in the cloud.
            None => path.exists() && !placeholder_path(path).exists(),
        }
    }

    fn download_error(path: &Path) -> Option<String> {
        // SAFETY: Foundation constant, valid for the life of the process.
        let key = unsafe { NSURLUbiquitousItemDownloadingErrorKey };
        let err = resource(path, key)?.downcast::<NSError>().ok()?;
        Some(err.localizedDescription().to_string())
    }

    /// Asks iCloud for the current version of a file and waits until it is on this Mac.
    pub fn ensure_downloaded(path: &Path) -> Result<(), IcloudError> {
        objc2::rc::autoreleasepool(|_| {
            if download_is_current(path) {
                return Ok(());
            }
            let Some(url) = NSURL::from_file_path(path) else {
                return Err(IcloudError::new("UNKNOWN", "Invalid iCloud Drive path."));
            };
            if let Err(err) =
                NSFileManager::defaultManager().startDownloadingUbiquitousItemAtURL_error(&url)
            {
                // Not an iCloud item after all (e.g. written moments ago and not uploaded yet).
                return if path.exists() {
                    Ok(())
                } else {
                    Err(IcloudError::new(
                        "NETWORK",
                        err.localizedDescription().to_string(),
                    ))
                };
            }
            let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
            while Instant::now() < deadline {
                if download_is_current(path) {
                    return Ok(());
                }
                if let Some(message) = download_error(path) {
                    return Err(IcloudError::new("NETWORK", message));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(IcloudError::new(
                "NETWORK",
                "iCloud Drive did not download the file in time. Check the connection and try again.",
            ))
        })
    }
}

#[cfg(target_os = "macos")]
use apple::{container_root, ensure_downloaded};

#[cfg(not(target_os = "macos"))]
fn container_root() -> Option<PathBuf> {
    None
}

#[cfg(not(target_os = "macos"))]
fn ensure_downloaded(_path: &Path) -> Result<(), IcloudError> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands (async, so the blocking container lookup and I/O stay off the main thread)
// ---------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, IcloudError> + Send + 'static,
) -> Result<T, IcloudError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|e| Err(IcloudError::new("UNKNOWN", e.to_string())))
}

fn root() -> Result<PathBuf, IcloudError> {
    container_root().ok_or_else(IcloudError::unavailable)
}

#[tauri::command]
pub async fn icloud_available() -> bool {
    blocking(|| Ok(container_root().is_some()))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn icloud_list_files(prefix: String) -> Result<Vec<FileEntry>, IcloudError> {
    blocking(move || list_files(&root()?, &prefix)).await
}

/// Returns the raw bytes (an `ArrayBuffer` in the WebView, no JSON number array).
#[tauri::command]
pub async fn icloud_read_file(path: String) -> Result<tauri::ipc::Response, IcloudError> {
    let bytes = blocking(move || read_file(&root()?, &path, ensure_downloaded)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The body is the raw file bytes; the path (URI-encoded) and `ifAbsent` travel as headers.
#[tauri::command]
pub async fn icloud_write_file(request: tauri::ipc::Request<'_>) -> Result<(), IcloudError> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(IcloudError::new(
            "UNKNOWN",
            "icloud_write_file expects raw bytes.",
        ));
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let path = header("x-icloud-path")
        .map(percent_decode)
        .transpose()?
        .ok_or_else(|| IcloudError::new("UNKNOWN", "path is required"))?;
    let if_absent = header("x-icloud-if-absent") == Some("1");
    let data = data.clone();
    blocking(move || write_file(&root()?, &path, &data, if_absent)).await
}

/// Decodes `encodeURIComponent` output.
fn percent_decode(value: &str) -> Result<String, IcloudError> {
    let bad = || IcloudError::new("UNKNOWN", "Badly encoded iCloud Drive path.");
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = value.get(i + 1..i + 3).ok_or_else(bad)?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| bad())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| bad())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flashcards-icloud-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn no_download(_: &Path) -> Result<(), IcloudError> {
        Ok(())
    }

    #[test]
    fn refuses_unsafe_paths() {
        let root = Path::new("root");
        for bad in ["", "/", "../x", "sync/../../x", "sync/./x", "a\0b"] {
            assert!(resolve(root, bad).is_err(), "{bad:?} should be refused");
        }
        #[cfg(windows)]
        for bad in ["C:/x", "C:x"] {
            assert!(resolve(root, bad).is_err(), "{bad:?} should be refused");
        }
        assert_eq!(
            resolve(root, "/sync\\dev-a//seg.json").unwrap(),
            root.join("sync").join("dev-a").join("seg.json")
        );
    }

    #[test]
    fn writes_reads_and_lists_like_the_ios_plugin() {
        let root = temp_root("roundtrip");
        write_file(&root, "sync/manifest.json", b"{}", false).unwrap();
        write_file(&root, "sync/dev-a/0001.seg", b"abc", true).unwrap();
        write_file(&root, "other/x.txt", b"x", false).unwrap();
        // Overwrite is atomic and leaves no temp file behind.
        write_file(&root, "sync/manifest.json", b"{\"v\":2}", false).unwrap();

        assert_eq!(
            read_file(&root, "sync/manifest.json", no_download).unwrap(),
            b"{\"v\":2}"
        );
        let listed = list_files(&root, "sync").unwrap();
        let paths: Vec<&str> = listed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["sync/dev-a/0001.seg", "sync/manifest.json"]);
        assert_eq!(listed[0].size, 3);
        assert!(listed[0].updated_at.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn if_absent_is_write_once() {
        let root = temp_root("once");
        write_file(&root, "sync/a.seg", b"1", true).unwrap();
        let err = write_file(&root, "sync/a.seg", b"2", true).unwrap_err();
        assert_eq!(err.code, "ALREADY_EXISTS");
        assert_eq!(read_file(&root, "sync/a.seg", no_download).unwrap(), b"1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn placeholders_stand_for_files_not_downloaded_yet() {
        let root = temp_root("placeholder");
        fs::create_dir_all(root.join("sync")).unwrap();
        fs::write(root.join("sync").join(".remote.seg.icloud"), b"plist").unwrap();
        fs::write(root.join("sync").join(".DS_Store"), b"x").unwrap();

        let listed = list_files(&root, "sync").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, "sync/remote.seg");
        assert_eq!(listed[0].size, 0);

        // Write-once refuses a file another device already created.
        assert_eq!(
            write_file(&root, "sync/remote.seg", b"x", true)
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        // Reading asks for the download first.
        let asked = std::cell::Cell::new(false);
        let err = read_file(&root, "sync/remote.seg", |_| {
            asked.set(true);
            Err(IcloudError::new("NETWORK", "offline"))
        })
        .unwrap_err();
        assert!(asked.get());
        assert_eq!(err.code, "NETWORK");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_files_and_folders() {
        let root = temp_root("missing");
        assert_eq!(
            read_file(&root, "sync/none.seg", no_download)
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        assert!(list_files(&root.join("absent"), "sync").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn decodes_uri_components() {
        assert_eq!(
            percent_decode("sync%2Fdev%20a%2F%ED%95%9C.seg").unwrap(),
            "sync/dev a/한.seg"
        );
        assert!(percent_decode("bad%2").is_err());
        assert!(percent_decode("bad%zz").is_err());
    }

    #[test]
    fn no_container_off_macos() {
        if cfg!(not(target_os = "macos")) {
            assert_eq!(root().unwrap_err().code, "AUTH_REQUIRED");
        }
    }
}
