package app.flashcards.securestorage;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.InvalidKeyException;
import java.security.Key;
import java.security.KeyStore;
import java.security.UnrecoverableKeyException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * AES-256-GCM with a key generated inside, and never exported from, {@code AndroidKeyStore}.
 *
 * <p>Format of a stored value: base64(version byte | 12-byte IV | ciphertext + 16-byte tag). The
 * entry name is bound as associated data, so a ciphertext copied to another entry fails to decrypt.
 */
final class KeystoreCipher {

    /** Thrown when a stored value is not in the format this class writes. */
    static final class UnreadableValueException extends GeneralSecurityException {

        UnreadableValueException(String message) {
            super(message);
        }
    }

    /**
     * Thrown when the Keystore key can no longer be loaded or used (some devices invalidate it after an
     * OS update). The key alias has already been deleted, so the next {@link #encrypt} creates a new
     * one; every value sealed with the old key is lost and must be dropped by the caller.
     */
    static final class KeyUnusableException extends GeneralSecurityException {

        KeyUnusableException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "app.flashcards.securestorage.aes.v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final byte FORMAT_VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private synchronized SecretKey getOrCreateKey() throws GeneralSecurityException, IOException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) {
            return (SecretKey) existing;
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return generator.generateKey();
    }

    private synchronized void deleteKey() throws GeneralSecurityException, IOException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            keyStore.deleteEntry(KEY_ALIAS);
        }
    }

    /** A cipher initialized with the Keystore key; {@code spec} is null for encryption. */
    private Cipher initCipher(int mode, GCMParameterSpec spec) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        try {
            SecretKey key = getOrCreateKey();
            if (spec == null) {
                cipher.init(mode, key);
            } else {
                cipher.init(mode, key, spec);
            }
        } catch (UnrecoverableKeyException | InvalidKeyException e) {
            try {
                deleteKey();
            } catch (GeneralSecurityException | IOException deleteFailure) {
                e.addSuppressed(deleteFailure);
            }
            throw new KeyUnusableException("The Keystore key can no longer be used", e);
        }
        return cipher;
    }

    private static byte[] associatedData(String entryName) {
        return ("app.flashcards.securestorage:" + entryName).getBytes(StandardCharsets.UTF_8);
    }

    String encrypt(String entryName, String plaintext) throws GeneralSecurityException, IOException {
        Cipher cipher = initCipher(Cipher.ENCRYPT_MODE, null);
        cipher.updateAAD(associatedData(entryName));
        byte[] sealed = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_BYTES) {
            throw new GeneralSecurityException("Unexpected GCM IV length");
        }
        ByteBuffer out = ByteBuffer.allocate(1 + IV_BYTES + sealed.length);
        out.put(FORMAT_VERSION).put(iv).put(sealed);
        return Base64.encodeToString(out.array(), Base64.NO_WRAP);
    }

    String decrypt(String entryName, String encoded) throws GeneralSecurityException, IOException {
        byte[] data;
        try {
            data = Base64.decode(encoded, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            throw new UnreadableValueException("Stored value is not base64");
        }
        if (data.length < 1 + IV_BYTES + TAG_BITS / 8 || data[0] != FORMAT_VERSION) {
            throw new UnreadableValueException("Stored value has an unknown format");
        }
        Cipher cipher = initCipher(Cipher.DECRYPT_MODE, new GCMParameterSpec(TAG_BITS, data, 1, IV_BYTES));
        cipher.updateAAD(associatedData(entryName));
        byte[] plain = cipher.doFinal(data, 1 + IV_BYTES, data.length - 1 - IV_BYTES);
        return new String(plain, StandardCharsets.UTF_8);
    }
}
