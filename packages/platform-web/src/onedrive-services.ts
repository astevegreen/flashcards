import type { Auth, OneDriveFilePicker, Storage, SyncTransport } from '@flash/platform';
import {
  NativeMicrosoftAuth,
  type MicrosoftPublicClientBridge,
} from './auth/microsoft-native-auth.ts';
import { MicrosoftOAuthWebAuth } from './auth/microsoft-oauth-web.ts';
import { GraphOneDriveFilePicker, type OneDrivePickerAuth } from './sources/onedrive-picker.ts';
import { OneDriveAppFolderTransport } from './sync/onedrive-transport.ts';

/**
 * OneDrive storage connector services (§15 Phase 12), loaded only on demand so none of it reaches
 * the initial study-screen chunk. Native shells reuse the transport and picker with their own
 * `Auth` (`createOneDriveServicesForAuth`).
 */
export interface OneDriveServices {
  auth: Auth & OneDrivePickerAuth;
  transport: SyncTransport;
  picker: OneDriveFilePicker;
}

export function createOneDriveServicesForAuth(
  auth: Auth & OneDrivePickerAuth,
  fetchImpl?: typeof fetch,
): OneDriveServices {
  return {
    auth,
    transport: new OneDriveAppFolderTransport({ auth, ...(fetchImpl ? { fetchImpl } : {}) }),
    picker: new GraphOneDriveFilePicker({ auth, ...(fetchImpl ? { fetchImpl } : {}) }),
  };
}

export function createOneDriveWebServices(options: {
  clientId: string;
  tokenHelperUrl: string;
  tenant?: string;
  storage: Storage;
}): OneDriveServices {
  const auth = new MicrosoftOAuthWebAuth({
    clientId: options.clientId,
    tokenHelperUrl: options.tokenHelperUrl,
    ...(options.tenant ? { tenant: options.tenant } : {}),
    storage: options.storage,
  });
  return createOneDriveServicesForAuth(auth);
}

/** Native shells (Capacitor / Tauri): public-client sign-in through a platform bridge. */
export function createNativeOneDriveServices(options: {
  bridge: MicrosoftPublicClientBridge;
  storage: Storage;
}): OneDriveServices {
  return createOneDriveServicesForAuth(
    new NativeMicrosoftAuth({ bridge: options.bridge, storage: options.storage }),
  );
}

export { MicrosoftOAuthWebAuth } from './auth/microsoft-oauth-web.ts';
export {
  MicrosoftRefreshRejectedError,
  NativeMicrosoftAuth,
  type MicrosoftPublicClientBridge,
  type MicrosoftTokenSet,
} from './auth/microsoft-native-auth.ts';
export { GraphOneDriveFilePicker } from './sources/onedrive-picker.ts';
export { OneDriveAppFolderTransport } from './sync/onedrive-transport.ts';
