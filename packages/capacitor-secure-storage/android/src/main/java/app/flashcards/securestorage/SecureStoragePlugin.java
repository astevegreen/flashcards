package app.flashcards.securestorage;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.security.GeneralSecurityException;
import javax.crypto.BadPaddingException;
import org.json.JSONObject;

/**
 * JS name {@code FlashSecureStorage}. Values are encrypted by {@link KeystoreCipher} (an AES-GCM key
 * held in {@code AndroidKeyStore}) and only the ciphertext is written to the app-private
 * SharedPreferences file {@value #PREFS_NAME}. Plaintext never touches disk.
 */
@CapacitorPlugin(name = "FlashSecureStorage")
public class SecureStoragePlugin extends Plugin {

    private static final String TAG = "FlashSecureStorage";
    private static final String PREFS_NAME = "app.flashcards.securestorage";
    private static final String ENTRY_PREFIX = "v1:";

    /*
     * The only plaintext token copies removeLegacyPreference may delete: a SharedPreferences file and
     * a key prefix, both written by @capgo/capacitor-social-login 8.7.x (OAuth2Provider.java PREFS_NAME
     * and PREFS_KEY_PREFIX; GoogleProvider.java SHARED_PREFERENCE_NAME and GOOGLE_DATA_PREFERENCE).
     */
    private static final String OAUTH2_PREFS_NAME = "CapgoOAuth2ProviderPrefs";
    private static final String OAUTH2_TOKEN_PREFIX = "OAuth2Tokens_";
    private static final String GOOGLE_PREFS_NAME = "GOOGLE_LOGIN_F13oz0I_SHARED_PERF";
    private static final String GOOGLE_DATA_PREFIX = "GOOGLE_LOGIN_GOOGLE_DATA_";

    private final KeystoreCipher cipher = new KeystoreCipher();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String requireKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required", "INVALID_ARGUMENT");
            return null;
        }
        return key;
    }

    /** Drops every stored secret, after the Keystore key that sealed them was lost. */
    private void dropAllEntries() {
        SharedPreferences.Editor editor = prefs().edit();
        for (String name : prefs().getAll().keySet()) {
            if (name.startsWith(ENTRY_PREFIX)) {
                editor.remove(name);
            }
        }
        editor.commit();
    }

    private static String allowedLegacyPrefix(String fileName) {
        if (OAUTH2_PREFS_NAME.equals(fileName)) {
            return OAUTH2_TOKEN_PREFIX;
        }
        if (GOOGLE_PREFS_NAME.equals(fileName)) {
            return GOOGLE_DATA_PREFIX;
        }
        return null;
    }

    private static boolean isAllowedLegacyPreference(String fileName, String key) {
        String prefix = allowedLegacyPrefix(fileName);
        return prefix != null && key.startsWith(prefix) && key.length() > prefix.length();
    }

    private static JSObject valueResult(String value) {
        JSObject result = new JSObject();
        result.put("value", value != null ? value : JSONObject.NULL);
        return result;
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = requireKey(call);
        if (key == null) {
            return;
        }
        String entry = ENTRY_PREFIX + key;
        String stored = prefs().getString(entry, null);
        if (stored == null) {
            call.resolve(valueResult(null));
            return;
        }
        try {
            call.resolve(valueResult(cipher.decrypt(entry, stored)));
        } catch (KeystoreCipher.UnreadableValueException | BadPaddingException e) {
            // The Keystore key no longer matches (e.g. data restored from a backup onto another device,
            // where the key does not exist). The value can never be recovered, so drop it.
            Logger.warn(TAG, "Dropping a stored secret that can no longer be decrypted");
            prefs().edit().remove(entry).commit();
            call.resolve(valueResult(null));
        } catch (KeystoreCipher.KeyUnusableException e) {
            // The key was invalidated (some devices do this after an OS update) and has been deleted.
            // Nothing sealed with it can be read again, so drop it all and let the user sign in again.
            Logger.warn(TAG, "The Keystore key is unusable; dropping every stored secret");
            dropAllEntries();
            call.resolve(valueResult(null));
        } catch (GeneralSecurityException | IOException e) {
            call.reject("Could not read from secure storage", "KEYSTORE_ERROR", e);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = requireKey(call);
        if (key == null) {
            return;
        }
        String value = call.getString("value");
        if (value == null) {
            call.reject("value is required", "INVALID_ARGUMENT");
            return;
        }
        String entry = ENTRY_PREFIX + key;
        try {
            String sealed = encryptWithRecovery(entry, value);
            if (!prefs().edit().putString(entry, sealed).commit()) {
                call.reject("Could not write to secure storage", "STORAGE_ERROR");
                return;
            }
            call.resolve();
        } catch (GeneralSecurityException | IOException e) {
            call.reject("Could not write to secure storage", "KEYSTORE_ERROR", e);
        }
    }

    /** Encrypts; if the Keystore key was lost, drops the unreadable entries and retries once with a new key. */
    private String encryptWithRecovery(String entry, String value) throws GeneralSecurityException, IOException {
        try {
            return cipher.encrypt(entry, value);
        } catch (KeystoreCipher.KeyUnusableException e) {
            Logger.warn(TAG, "The Keystore key is unusable; dropping every stored secret and creating a new key");
            dropAllEntries();
            return cipher.encrypt(entry, value);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = requireKey(call);
        if (key == null) {
            return;
        }
        if (!prefs().edit().remove(ENTRY_PREFIX + key).commit()) {
            call.reject("Could not delete from secure storage", "STORAGE_ERROR");
            return;
        }
        call.resolve();
    }

    /**
     * Clears a plaintext token copy the sign-in plugin left in its own SharedPreferences file. Only the
     * entries in the allowlist above can be deleted; anything else is rejected.
     */
    @PluginMethod
    public void removeLegacyPreference(PluginCall call) {
        String key = requireKey(call);
        if (key == null) {
            return;
        }
        String fileName = call.getString("androidPreferencesName");
        if (!isAllowedLegacyPreference(fileName, key)) {
            call.reject("Not a known sign-in token copy", "INVALID_ARGUMENT");
            return;
        }
        getContext().getSharedPreferences(fileName, Context.MODE_PRIVATE).edit().remove(key).commit();
        call.resolve();
    }
}
