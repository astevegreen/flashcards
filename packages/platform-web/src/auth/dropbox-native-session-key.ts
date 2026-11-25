/**
 * App-database KV key for the native Dropbox session (`NativeDropboxAuth`).
 * Kept in its own tiny module so `@flash/platform-capacitor` can import it via
 * `@flash/platform-web/native-support` without pulling the Dropbox client into boot.
 */
export const DROPBOX_NATIVE_SESSION_KV_KEY = 'dropbox_native_session_v1';
