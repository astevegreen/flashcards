import type { Auth, DropboxFilePicker, Storage, SyncTransport } from '@flash/platform';
import { NativeDropboxAuth, type DropboxPublicClientBridge } from './auth/dropbox-native-auth.ts';
import { DropboxOAuthWebAuth } from './auth/dropbox-oauth-web.ts';
import { DropboxAppFolderFilePicker } from './sources/dropbox-picker.ts';
import { DropboxAppFolderTransport } from './sync/dropbox-transport.ts';

/**
 * Dropbox App Folder storage connector services (Sync + Linked Sources), loaded only on demand
 * so none of it reaches the initial study-screen chunk (§8). Native shells reuse the transport
 * and picker with their own `Auth` (`createDropboxServicesForAuth`).
 */
export interface DropboxServices {
  auth: Auth;
  transport: SyncTransport;
  picker: DropboxFilePicker;
}

export function createDropboxServicesForAuth(
  auth: Auth,
  fetchImpl?: typeof fetch,
): DropboxServices {
  return {
    auth,
    transport: new DropboxAppFolderTransport({
      getAccessToken: () => auth.getValidAccessToken(),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    picker: new DropboxAppFolderFilePicker({
      auth,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  };
}

export function createDropboxWebServices(options: {
  appKey: string;
  storage: Storage;
}): DropboxServices {
  const auth = new DropboxOAuthWebAuth({
    appKey: options.appKey,
    storage: options.storage,
  });
  return createDropboxServicesForAuth(auth);
}

/** Native shells (Capacitor / Tauri): public-client PKCE sign-in through a platform bridge. */
export function createNativeDropboxServices(options: {
  bridge: DropboxPublicClientBridge;
  storage: Storage;
}): DropboxServices {
  return createDropboxServicesForAuth(
    new NativeDropboxAuth({ bridge: options.bridge, storage: options.storage }),
  );
}

export { DropboxOAuthWebAuth } from './auth/dropbox-oauth-web.ts';
export {
  DropboxRefreshRejectedError,
  NativeDropboxAuth,
  type DropboxPublicClientBridge,
  type DropboxTokenSet,
} from './auth/dropbox-native-auth.ts';
export {
  DROPBOX_PICKABLE_EXTENSIONS,
  DROPBOX_SYNC_ROOT_FOLDERS,
  DropboxAppFolderFilePicker,
  encodeDropboxApiArg,
  isPickableDropboxFile,
} from './sources/dropbox-picker.ts';
export { DROPBOX_APP_FOLDER_SCOPES, DropboxAppFolderTransport } from './sync/dropbox-transport.ts';
