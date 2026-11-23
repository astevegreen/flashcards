import Foundation
import Capacitor

/// JS name `FlashSecureStorage`. Secrets live in the Keychain (see `KeychainStore`); nothing is
/// ever written to UserDefaults or files.
@objc(FlashSecureStoragePlugin)
public class FlashSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FlashSecureStoragePlugin"
    public let jsName = "FlashSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeLegacyPreference", returnType: CAPPluginReturnPromise)
    ]

    private lazy var store = KeychainStore(
        service: "\(Bundle.main.bundleIdentifier ?? "app.flashcards.localfirst").secure-storage"
    )

    private func requireKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required", "INVALID_ARGUMENT")
            return nil
        }
        return key
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        do {
            if let value = try store.get(key) {
                call.resolve(["value": value])
            } else {
                call.resolve(["value": NSNull()])
            }
        } catch {
            call.reject("Could not read from the Keychain", "KEYCHAIN_ERROR", error)
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("value is required", "INVALID_ARGUMENT")
            return
        }
        do {
            try store.set(key, value: value)
            call.resolve()
        } catch {
            call.reject("Could not write to the Keychain", "KEYCHAIN_ERROR", error)
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        do {
            try store.remove(key)
            call.resolve()
        } catch {
            call.reject("Could not delete from the Keychain", "KEYCHAIN_ERROR", error)
        }
    }

    /// The only `UserDefaults.standard` keys `removeLegacyPreference` may delete: the plaintext OAuth2
    /// token copies `@capgo/capacitor-social-login` 8.7.x writes (`OAuth2Provider.swift`,
    /// `tokenStorageKeyPrefix`).
    private static let legacyPreferencePrefix = "CapgoOAuth2ProviderTokens_"

    /// Clears a plaintext token copy the sign-in plugin kept in `UserDefaults.standard`. Any key outside
    /// the allowlist is rejected.
    @objc func removeLegacyPreference(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        let prefix = Self.legacyPreferencePrefix
        guard key.hasPrefix(prefix), key.count > prefix.count else {
            call.reject("Not a known sign-in token copy", "INVALID_ARGUMENT")
            return
        }
        UserDefaults.standard.removeObject(forKey: key)
        call.resolve()
    }
}
