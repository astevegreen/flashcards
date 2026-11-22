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
            String sealed = cipher.encrypt(entry, value);
            if (!prefs().edit().putString(entry, sealed).commit()) {
                call.reject("Could not write to secure storage", "STORAGE_ERROR");
                return;
            }
            call.resolve();
        } catch (GeneralSecurityException | IOException e) {
            call.reject("Could not write to secure storage", "KEYSTORE_ERROR", e);
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

    /** Clears a plaintext entry another plugin left in one of this app's SharedPreferences files. */
    @PluginMethod
    public void removeLegacyPreference(PluginCall call) {
        String key = requireKey(call);
        if (key == null) {
            return;
        }
        String fileName = call.getString("androidPreferencesName");
        if (fileName == null || fileName.isEmpty() || PREFS_NAME.equals(fileName)) {
            call.reject("androidPreferencesName must name another SharedPreferences file", "INVALID_ARGUMENT");
            return;
        }
        getContext().getSharedPreferences(fileName, Context.MODE_PRIVATE).edit().remove(key).commit();
        call.resolve();
    }
}
