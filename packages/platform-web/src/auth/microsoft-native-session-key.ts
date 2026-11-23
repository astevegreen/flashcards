/**
 * App database (`Storage.getKv`) key of the native OneDrive session record (`NativeMicrosoftAuth`).
 * A leaf module so the Capacitor secure-KV routing can import it without loading the OneDrive code.
 */
export const ONEDRIVE_NATIVE_SESSION_KV_KEY = 'onedrive_native_session_v1';
