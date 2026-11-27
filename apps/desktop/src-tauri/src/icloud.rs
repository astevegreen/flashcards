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
//! `icloud_supported` is true only on a macOS build signed with the iCloud (ubiquity container)
//! entitlement. Unsigned builds (no Apple Developer account yet) and Windows / Linux have no
//! container: the app then never offers iCloud, `icloud_available` is false and every other
//! command fails with `AUTH_REQUIRED`. The file logic itself is plain `std::fs` and is unit-tested
//! on every platform against a temporary folder.

use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Must match the iOS entitlement (`App.entitlements`) so both apps open the same container.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CONTAINER_ID: &str = "iCloud.app.flashcards.localfirst";

/// Hidden folder at the container root for atomic-replace temp files.
const TEMP_DIR: &str = ".flashcards-tmp";

/// A temp file older than this was left behind by a crash (a write takes seconds at most). Long
/// enough that a write still in progress on another device, whose clock may be off, is never hit.
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

/// Placeholders are tiny property lists; anything bigger is not read.
const MAX_PLACEHOLDER_BYTES: u64 = 64 * 1024;

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

/// The real file's size recorded in an iCloud placeholder: `NSURLFileSizeKey` in its property list
/// (binary or XML). `None` when the placeholder is not a property list or has no size.
fn placeholder_size(bytes: &[u8]) -> Option<u64> {
    let value = plist::Value::from_reader(io::Cursor::new(bytes)).ok()?;
    value
        .as_dictionary()?
        .get("NSURLFileSizeKey")?
        .as_unsigned_integer()
}

fn millis(meta: &fs::Metadata) -> Option<f64> {
    let since = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((since.as_secs_f64() * 1000.0).round())
}

// ---------------------------------------------------------------------------
// Listing, reading and writing (platform-independent)
// ---------------------------------------------------------------------------

fn join_rel(rel_dir: &str, name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_string()
    } else {
        format!("{rel_dir}/{name}")
    }
}

/// The listing entry for one regular file, and whether it is an iCloud placeholder; `None` for
/// hidden files and files outside `prefix`.
fn file_entry(
    entry: &fs::DirEntry,
    name: &str,
    rel_dir: &str,
    prefix: &str,
) -> Option<(FileEntry, bool)> {
    let (rel, is_placeholder) = match placeholder_target(name) {
        Some(target) => (join_rel(rel_dir, target), true),
        None if name.starts_with('.') => return None,
        None => (join_rel(rel_dir, name), false),
    };
    if !rel.starts_with(prefix) {
        return None;
    }
    let meta = entry.metadata().ok();
    // A placeholder's own size is not the file's size: read the real one from its property list.
    // 0 when that fails (the listed size is informational; the sync engine does not use it).
    let size = match &meta {
        Some(m) if !is_placeholder => m.len(),
        Some(m) if m.len() <= MAX_PLACEHOLDER_BYTES => fs::read(entry.path())
            .ok()
            .and_then(|bytes| placeholder_size(&bytes))
            .unwrap_or(0),
        _ => 0,
    };
    let updated_at = meta.as_ref().and_then(millis);
    Some((
        FileEntry {
            path: rel,
            size,
            updated_at,
        },
        is_placeholder,
    ))
}

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
            if file_type.is_dir() && !name.starts_with('.') {
                stack.push((entry.path(), join_rel(&rel_dir, &name)));
            } else if file_type.is_file() {
                let Some((file, is_placeholder)) = file_entry(&entry, &name, &rel_dir, prefix)
                else {
                    continue;
                };
                // The real file wins over its placeholder.
                if !matches!(found.get(&file.path), Some((_, false))) {
                    found.insert(file.path.clone(), (file, is_placeholder));
                }
            }
        }
    }
    Ok(found.into_values().map(|(f, _)| f).collect())
}

/// Whether `name` in the temp folder is one of `write_file`'s temp files (`<pid>-<nanos>.tmp`, or
/// the iCloud placeholder of one another device left behind) and `age` makes it a crash leftover.
fn is_stale_temp(name: &str, age: Option<Duration>) -> bool {
    let name = placeholder_target(name).unwrap_or(name);
    let Some((pid, nanos)) = name.strip_suffix(".tmp").and_then(|s| s.split_once('-')) else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(pid) && digits(nanos) && age.is_some_and(|a| a >= STALE_TEMP_AGE)
}

/// Deletes temp files that a write interrupted by a crash left in the temp folder. Best effort:
/// errors are ignored. Returns how many were deleted.
pub fn sweep_stale_temps(root: &Path, now: SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(root.join(TEMP_DIR)) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        // A modification time in the future gives no age, so the file is kept.
        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok());
        if meta.is_file() && is_stale_temp(&name, age) && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// With `max_bytes`, a file larger than that fails with `TOO_LARGE` before it is read.
pub fn read_file(
    root: &Path,
    relative: &str,
    max_bytes: Option<u64>,
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
    if let Some(max) = max_bytes {
        let size = fs::metadata(&path)
            .map_err(|e| IcloudError::io(&e, relative))?
            .len();
        if size > max {
            return Err(IcloudError::new(
                "TOO_LARGE",
                format!("iCloud Drive sync file \"{relative}\" is {size} bytes, over {max}."),
            ));
        }
    }
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
    // Temp file in a hidden folder at the container root, outside every sync prefix (so neither
    // this walker nor the iOS metadata query lists it), then renamed over the target.
    let tmp_dir = root.join(TEMP_DIR);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = tmp_dir.join(format!("{}-{nanos}.tmp", std::process::id()));
    let result = (|| {
        fs::create_dir_all(&tmp_dir)?;
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
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    static CACHED_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
    static ENTITLED: OnceLock<bool> = OnceLock::new();
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

    /// The container root, or `None` when the user is signed out of iCloud, iCloud Drive is off,
    /// or the build lacks the iCloud entitlement. Blocks, so never call it on the main thread.
    pub fn container_root() -> Option<PathBuf> {
        if !has_ubiquity_entitlement() {
            return None;
        }
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

    type CFTypeRef = *const c_void;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecTaskCreateFromSelf(allocator: CFTypeRef) -> CFTypeRef;
        fn SecTaskCopyValueForEntitlement(
            task: CFTypeRef,
            entitlement: CFTypeRef,
            error: *mut CFTypeRef,
        ) -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
    }

    /// Entitlement `URLForUbiquityContainerIdentifier` needs (see `macos/Flashcards.entitlements`).
    const UBIQUITY_ENTITLEMENT: &str = "com.apple.developer.ubiquity-container-identifiers";

    /// Whether this process was signed with the iCloud Drive (ubiquity container) entitlement.
    /// Unsigned and ad-hoc signed builds have none, so iCloud can never work there. Read from the
    /// code signature once; no iCloud call, so it is cheap and never blocks.
    pub fn has_ubiquity_entitlement() -> bool {
        *ENTITLED.get_or_init(|| {
            let name = NSString::from_str(UBIQUITY_ENTITLEMENT);
            // SAFETY: plain Security / CoreFoundation calls. `NSString` is toll-free bridged to
            // `CFString`; every object these functions return is owned here and released once.
            unsafe {
                let task = SecTaskCreateFromSelf(std::ptr::null());
                if task.is_null() {
                    return false;
                }
                let name_ref: CFTypeRef = objc2::rc::Retained::as_ptr(&name).cast();
                let value = SecTaskCopyValueForEntitlement(task, name_ref, std::ptr::null_mut());
                CFRelease(task);
                if value.is_null() {
                    return false;
                }
                CFRelease(value);
                true
            }
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
use apple::{container_root, ensure_downloaded, has_ubiquity_entitlement};

#[cfg(not(target_os = "macos"))]
fn container_root() -> Option<PathBuf> {
    None
}

#[cfg(not(target_os = "macos"))]
fn has_ubiquity_entitlement() -> bool {
    false
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

/// True on a macOS build signed with the iCloud entitlement (where the container may exist),
/// false on unsigned Mac builds and elsewhere. Cheap: reads the code signature, no iCloud call.
#[tauri::command]
pub fn icloud_supported() -> bool {
    has_ubiquity_entitlement()
}

#[tauri::command]
pub async fn icloud_available() -> bool {
    blocking(|| Ok(container_root().is_some()))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn icloud_list_files(prefix: String) -> Result<Vec<FileEntry>, IcloudError> {
    blocking(move || {
        let root = root()?;
        // Every sync lists first, so crash leftovers go at the first sync after a restart.
        sweep_stale_temps(&root, SystemTime::now());
        list_files(&root, &prefix)
    })
    .await
}

/// Returns the raw bytes (an `ArrayBuffer` in the WebView, no JSON number array).
#[tauri::command]
pub async fn icloud_read_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<tauri::ipc::Response, IcloudError> {
    let bytes = blocking(move || read_file(&root()?, &path, max_bytes, ensure_downloaded)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The body is the raw file bytes; the path (URI-encoded) and `ifAbsent` travel as headers.
#[tauri::command]
pub async fn icloud_write_file(request: tauri::ipc::Request<'_>) -> Result<(), IcloudError> {
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        // Fallback when an IPC path serializes the bytes as a JSON number array.
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value::<Vec<u8>>(value.clone())
            .map_err(|_| IcloudError::new("UNKNOWN", "icloud_write_file expects file bytes."))?,
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let path = header("x-icloud-path")
        .map(percent_decode)
        .transpose()?
        .ok_or_else(|| IcloudError::new("UNKNOWN", "path is required"))?;
    let if_absent = header("x-icloud-if-absent") == Some("1");
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

    /// Shaped like the binary plist macOS writes for `.<name>.icloud`.
    fn placeholder_plist(size: u64) -> Vec<u8> {
        let mut dict = plist::Dictionary::new();
        dict.insert("NSURLNameKey".into(), "remote.seg".into());
        dict.insert("NSURLFileSizeKey".into(), size.into());
        dict.insert(
            "NSURLFileResourceTypeKey".into(),
            "NSURLFileResourceTypeRegular".into(),
        );
        let mut out = Vec::new();
        plist::to_writer_binary(&mut out, &plist::Value::Dictionary(dict)).unwrap();
        out
    }

    #[test]
    fn reads_the_size_from_placeholders() {
        assert_eq!(placeholder_size(&placeholder_plist(123_456)), Some(123_456));
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSURLFileSizeKey</key><integer>42</integer></dict></plist>"#;
        assert_eq!(placeholder_size(xml), Some(42));
        assert_eq!(placeholder_size(b""), None);
        assert_eq!(placeholder_size(b"bplist00garbage"), None);
        let mut no_size = Vec::new();
        plist::to_writer_binary(&mut no_size, &plist::Value::Dictionary(Default::default()))
            .unwrap();
        assert_eq!(placeholder_size(&no_size), None);
    }

    #[test]
    fn matches_only_old_temp_files() {
        let old = Some(STALE_TEMP_AGE);
        let fresh = Some(STALE_TEMP_AGE - Duration::from_secs(1));
        assert!(is_stale_temp("123-1700000000000000000.tmp", old));
        assert!(is_stale_temp(".123-1700000000000000000.tmp.icloud", old));
        assert!(!is_stale_temp("123-1700000000000000000.tmp", fresh));
        assert!(!is_stale_temp("123-1700000000000000000.tmp", None));
        for other in [
            "manifest.json",
            "123.tmp",
            "-1.tmp",
            "1-.tmp",
            "a-1.tmp",
            "1-2.tmp.bak",
            "1-2-3.tmp",
            ".1-2.tmp",
        ] {
            assert!(!is_stale_temp(other, old), "{other:?} should be kept");
        }
    }

    #[test]
    fn sweeps_temp_files_left_by_a_crash() {
        let root = temp_root("sweep");
        let tmp = root.join(TEMP_DIR);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("99-1.tmp"), b"partial").unwrap();
        fs::write(tmp.join(".98-2.tmp.icloud"), b"plist").unwrap();
        fs::write(tmp.join("notes.txt"), b"keep").unwrap();
        fs::create_dir_all(root.join("sync")).unwrap();
        fs::write(
            root.join("sync").join("1-2.tmp"),
            b"outside the temp folder",
        )
        .unwrap();

        // Just written: kept.
        assert_eq!(sweep_stale_temps(&root, SystemTime::now()), 0);
        // An hour and more later the temp files go, and nothing else does.
        let later = SystemTime::now() + STALE_TEMP_AGE + Duration::from_secs(60);
        assert_eq!(sweep_stale_temps(&root, later), 2);
        let left: Vec<_> = fs::read_dir(&tmp)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["notes.txt"]);
        assert!(root.join("sync").join("1-2.tmp").exists());
        assert_eq!(sweep_stale_temps(&root.join("absent"), later), 0);
        fs::remove_dir_all(root).unwrap();
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
        assert_eq!(fs::read_dir(root.join(TEMP_DIR)).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("sync")).unwrap().count(), 2);

        assert_eq!(
            read_file(&root, "sync/manifest.json", None, no_download).unwrap(),
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
    fn max_bytes_refuses_larger_files_before_reading() {
        let root = temp_root("maxbytes");
        write_file(&root, "sync/big.seg", b"12345", false).unwrap();
        assert_eq!(
            read_file(&root, "sync/big.seg", Some(5), no_download).unwrap(),
            b"12345"
        );
        let err = read_file(&root, "sync/big.seg", Some(4), no_download).unwrap_err();
        assert_eq!(err.code, "TOO_LARGE");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn if_absent_is_write_once() {
        let root = temp_root("once");
        write_file(&root, "sync/a.seg", b"1", true).unwrap();
        let err = write_file(&root, "sync/a.seg", b"2", true).unwrap_err();
        assert_eq!(err.code, "ALREADY_EXISTS");
        assert_eq!(read_file(&root, "sync/a.seg", None, no_download).unwrap(), b"1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn placeholders_stand_for_files_not_downloaded_yet() {
        let root = temp_root("placeholder");
        fs::create_dir_all(root.join("sync")).unwrap();
        fs::write(
            root.join("sync").join(".remote.seg.icloud"),
            placeholder_plist(4096),
        )
        .unwrap();
        fs::write(root.join("sync").join(".broken.seg.icloud"), b"not a plist").unwrap();
        fs::write(root.join("sync").join(".DS_Store"), b"x").unwrap();

        let listed = list_files(&root, "sync").unwrap();
        let paths: Vec<&str> = listed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["sync/broken.seg", "sync/remote.seg"]);
        // The real size from the placeholder; 0 when it cannot be read.
        assert_eq!(listed[0].size, 0);
        assert_eq!(listed[1].size, 4096);

        // Once downloaded, the real file wins over a placeholder that is still there.
        fs::write(root.join("sync").join(".local.seg.icloud"), b"plist").unwrap();
        fs::write(root.join("sync").join("local.seg"), b"12345").unwrap();
        let local: Vec<_> = list_files(&root, "sync/local").unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].size, 5);

        // Write-once refuses a file another device already created.
        assert_eq!(
            write_file(&root, "sync/remote.seg", b"x", true)
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        // Reading asks for the download first.
        let asked = std::cell::Cell::new(false);
        let err = read_file(&root, "sync/remote.seg", None, |_| {
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
            read_file(&root, "sync/none.seg", None, no_download)
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

    #[test]
    fn unsigned_builds_do_not_offer_icloud() {
        // Test binaries are never signed with the iCloud entitlement, on any OS.
        assert!(!icloud_supported());
    }
}
