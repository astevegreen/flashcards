import Capacitor
import Foundation

/// iCloud Drive file I/O behind `ICloudDriveSyncTransport`
/// (packages/platform-capacitor/src/sync/icloud-transport.ts).
///
/// Sync files live in the app's iCloud container *outside* `Documents/`, so they move between
/// the user's devices without showing up in the Files app. Bytes cross the bridge as base64.
/// Rejections carry the `SyncTransportError` codes the sync engine understands
/// (`NOT_FOUND`, `ALREADY_EXISTS`, `AUTH_REQUIRED`, `UNKNOWN`).
///
/// Registered by `MainViewController`; needs the iCloud Documents entitlement in `App.entitlements`.
@objc(ICloudDocumentsPlugin)
public class ICloudDocumentsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudDocumentsPlugin"
    public let jsName = "ICloudDocuments"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
    ]

    private struct FileInfo {
        let size: Int
        let updatedAt: Date?
    }

    /// File coordination blocks, so all I/O runs here, never on the main thread.
    private let ioQueue = DispatchQueue(
        label: "app.flashcards.icloud-documents", qos: .userInitiated, attributes: .concurrent)
    private let containerLock = NSLock()
    private var cachedRoot: URL?
    /// Keeps running metadata queries alive. Main thread only.
    private var runningQueries = Set<NSMetadataQuery>()

    private static let downloadTimeout: TimeInterval = 60
    private static let queryTimeout: TimeInterval = 20

    // MARK: - Plugin methods

    @objc func isAvailable(_ call: CAPPluginCall) {
        ioQueue.async {
            call.resolve(["available": self.containerRoot() != nil])
        }
    }

    @objc func listFiles(_ call: CAPPluginCall) {
        let prefix = call.getString("prefix") ?? ""
        ioQueue.async {
            guard let root = self.containerRoot() else { return self.rejectUnavailable(call) }
            let local = self.enumerateLocalFiles(root: root, prefix: prefix)
            self.queryCloudFiles(root: root, prefix: prefix) { cloud in
                // The metadata query also sees files not downloaded to this device yet. Files
                // written moments ago may not be indexed yet, so local files fill the gaps.
                var merged = cloud
                for (path, info) in local where merged[path] == nil {
                    merged[path] = info
                }
                let files: [[String: Any]] = merged.keys.sorted().map { path in
                    let info = merged[path]!
                    var entry: [String: Any] = ["path": path, "size": info.size]
                    if let date = info.updatedAt {
                        entry["updatedAt"] = (date.timeIntervalSince1970 * 1000).rounded()
                    }
                    return entry
                }
                call.resolve(["files": files])
            }
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            return call.reject("path is required", "UNKNOWN")
        }
        ioQueue.async {
            guard let root = self.containerRoot() else { return self.rejectUnavailable(call) }
            guard let url = Self.resolve(path, in: root) else {
                return call.reject("Unsafe iCloud Drive sync path \"\(path)\"", "UNKNOWN")
            }
            guard self.existsLocallyOrInCloud(url) else {
                return call.reject("iCloud Drive sync file not found: \"\(path)\"", "NOT_FOUND")
            }
            if let error = self.ensureDownloaded(url) {
                return self.reject(call, error, path: path)
            }

            var coordinationError: NSError?
            var result: Result<Data, Error>?
            NSFileCoordinator(filePresenter: nil).coordinate(
                readingItemAt: url, options: [], error: &coordinationError
            ) { readURL in
                result = Result { try Data(contentsOf: readURL) }
            }
            if let coordinationError {
                return self.reject(call, coordinationError, path: path)
            }
            switch result {
            case .success(let data):
                call.resolve(["data": data.base64EncodedString()])
            case .failure(let error):
                self.reject(call, error, path: path)
            case nil:
                call.reject("iCloud Drive read of \"\(path)\" did not run.", "UNKNOWN")
            }
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            return call.reject("path is required", "UNKNOWN")
        }
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else {
            return call.reject("data must be a base64 string", "UNKNOWN")
        }
        let ifAbsent = call.getBool("ifAbsent") ?? false

        ioQueue.async {
            guard let root = self.containerRoot() else { return self.rejectUnavailable(call) }
            guard let url = Self.resolve(path, in: root) else {
                return call.reject("Unsafe iCloud Drive sync path \"\(path)\"", "UNKNOWN")
            }
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            } catch {
                return self.reject(call, error, path: path)
            }

            var coordinationError: NSError?
            var outcome: Result<Void, Error>?
            NSFileCoordinator(filePresenter: nil).coordinate(
                writingItemAt: url, options: ifAbsent ? [] : .forReplacing, error: &coordinationError
            ) { writeURL in
                if ifAbsent && self.existsLocallyOrInCloud(writeURL) {
                    outcome = .failure(CocoaError(.fileWriteFileExists))
                    return
                }
                // `.withoutOverwriting` is an exclusive create, so a racing local writer loses too.
                outcome = Result {
                    try data.write(to: writeURL, options: ifAbsent ? [.withoutOverwriting] : [.atomic])
                }
            }
            if let coordinationError {
                return self.reject(call, coordinationError, path: path)
            }
            switch outcome {
            case .success:
                call.resolve()
            case .failure(let error):
                self.reject(call, error, path: path)
            case nil:
                call.reject("iCloud Drive write of \"\(path)\" did not run.", "UNKNOWN")
            }
        }
    }

    // MARK: - Container and paths

    /// The iCloud container root, or nil when the user is signed out of iCloud or has iCloud
    /// Drive off for this app. Apple says not to call this on the main thread.
    private func containerRoot() -> URL? {
        containerLock.lock()
        defer { containerLock.unlock() }
        guard FileManager.default.ubiquityIdentityToken != nil else {
            cachedRoot = nil
            return nil
        }
        if let cachedRoot { return cachedRoot }
        guard let url = FileManager.default.url(forUbiquityContainerIdentifier: nil) else {
            return nil
        }
        let root = url.standardizedFileURL
        cachedRoot = root
        return root
    }

    /// Joins a relative sync path onto the root, refusing `..`, `.`, NUL and empty paths.
    private static func resolve(_ relative: String, in root: URL) -> URL? {
        let normalized = relative.replacingOccurrences(of: "\\", with: "/")
        let parts = normalized.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.isEmpty, !normalized.contains("\0"),
              !parts.contains(where: { $0 == ".." || $0 == "." })
        else { return nil }
        return parts.reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    /// `/var` is a symlink to `/private/var`, and URLs from different APIs disagree about which
    /// spelling they use (resolving symlinks also fails for files not downloaded yet).
    private static func canonicalPath(_ url: URL) -> String {
        let path = url.standardizedFileURL.path
        return path.hasPrefix("/private/") ? String(path.dropFirst("/private".count)) : path
    }

    private static func relativePath(of url: URL, root: URL) -> String? {
        let full = canonicalPath(url)
        let rootPath = canonicalPath(root)
        let base = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard full.hasPrefix(base) else { return nil }
        let rel = String(full.dropFirst(base.count))
        return rel.isEmpty ? nil : rel
    }

    /// Older iOS versions stand in for an undownloaded file with a hidden `.<name>.icloud` file.
    private static func placeholderURL(for url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    }

    private func existsLocallyOrInCloud(_ url: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: url.path) || fm.fileExists(atPath: Self.placeholderURL(for: url).path)
    }

    // MARK: - Listing

    private func enumerateLocalFiles(root: URL, prefix: String) -> [String: FileInfo] {
        var out: [String: FileInfo] = [:]
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
        else { return out }
        for case let url as URL in walker {
            guard let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true,
                  let rel = Self.relativePath(of: url, root: root),
                  rel.hasPrefix(prefix)
            else { continue }
            out[rel] = FileInfo(size: values.fileSize ?? 0, updatedAt: values.contentModificationDate)
        }
        return out
    }

    /// Lists every file iCloud knows about in the container, downloaded or not.
    /// `NSMetadataQuery` needs a run loop, so it runs on the main thread.
    private func queryCloudFiles(
        root: URL, prefix: String, completion: @escaping ([String: FileInfo]) -> Void
    ) {
        DispatchQueue.main.async {
            let query = NSMetadataQuery()
            query.searchScopes = [NSMetadataQueryUbiquitousDataScope]
            query.predicate = NSPredicate(format: "%K LIKE %@", NSMetadataItemFSNameKey, "*")

            var observer: NSObjectProtocol?
            var timeout: DispatchWorkItem?
            let finish = { [weak self] in
                guard let self, self.runningQueries.contains(query) else { return }
                query.disableUpdates()
                query.stop()
                self.runningQueries.remove(query)
                if let observer { NotificationCenter.default.removeObserver(observer) }
                timeout?.cancel()

                var out: [String: FileInfo] = [:]
                for case let item as NSMetadataItem in query.results {
                    if let type = item.value(forAttribute: NSMetadataItemContentTypeKey) as? String,
                       type == "public.folder" {
                        continue
                    }
                    guard let url = item.value(forAttribute: NSMetadataItemURLKey) as? URL,
                          let rel = Self.relativePath(of: url, root: root),
                          rel.hasPrefix(prefix)
                    else { continue }
                    let size = (item.value(forAttribute: NSMetadataItemFSSizeKey) as? NSNumber)?.intValue ?? 0
                    let date = item.value(forAttribute: NSMetadataItemFSContentChangeDateKey) as? Date
                    out[rel] = FileInfo(size: size, updatedAt: date)
                }
                completion(out)
            }

            observer = NotificationCenter.default.addObserver(
                forName: .NSMetadataQueryDidFinishGathering, object: query, queue: .main
            ) { _ in finish() }
            let work = DispatchWorkItem { finish() }
            timeout = work
            self.runningQueries.insert(query)
            if !query.start() {
                finish()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.queryTimeout, execute: work)
        }
    }

    // MARK: - Downloading

    /// Asks iCloud for the current version of a file and waits until it is on this device.
    private func ensureDownloaded(_ url: URL) -> Error? {
        let fm = FileManager.default
        if downloadIsCurrent(url) { return nil }
        do {
            try fm.startDownloadingUbiquitousItem(at: url)
        } catch {
            // Not an iCloud item after all (e.g. written moments ago and not uploaded yet).
            return fm.fileExists(atPath: url.path) ? nil : error
        }
        let deadline = Date().addingTimeInterval(Self.downloadTimeout)
        while Date() < deadline {
            if downloadIsCurrent(url) { return nil }
            var probe = url
            probe.removeAllCachedResourceValues()
            if let error = try? probe.resourceValues(forKeys: [.ubiquitousItemDownloadingErrorKey])
                .ubiquitousItemDownloadingError {
                return error
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return CocoaError(.ubiquitousFileUnavailable)
    }

    private func downloadIsCurrent(_ url: URL) -> Bool {
        var probe = url
        probe.removeAllCachedResourceValues()
        let status = try? probe.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
            .ubiquitousItemDownloadingStatus
        if status == .current { return true }
        // No iCloud status means a plain local file; a placeholder means it is still in the cloud.
        let fm = FileManager.default
        return status == nil && fm.fileExists(atPath: url.path)
            && !fm.fileExists(atPath: Self.placeholderURL(for: url).path)
    }

    // MARK: - Errors

    private func rejectUnavailable(_ call: CAPPluginCall) {
        call.reject(
            "iCloud Drive is not available. Sign in to iCloud and turn on iCloud Drive for Flashcards in Settings.",
            "AUTH_REQUIRED")
    }

    private func reject(_ call: CAPPluginCall, _ error: Error, path: String) {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain {
            switch ns.code {
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError:
                return call.reject("iCloud Drive sync file not found: \"\(path)\"", "NOT_FOUND", error)
            case NSFileWriteFileExistsError:
                return call.reject(
                    "iCloud Drive write-once file already exists: \"\(path)\"", "ALREADY_EXISTS", error)
            case NSUbiquitousFileUnavailableError, NSUbiquitousFileNotUploadedDueToQuotaError:
                return call.reject(
                    "iCloud Drive could not provide \"\(path)\": \(ns.localizedDescription)", "NETWORK", error)
            default:
                break
            }
        }
        call.reject("iCloud Drive error for \"\(path)\": \(ns.localizedDescription)", "UNKNOWN", error)
    }
}
