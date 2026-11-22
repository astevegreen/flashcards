import {
  WebLicensePurchase,
  type WebLicensePurchaseOptions,
} from '@flash/platform-web/purchase-license';

export type TauriDesktopLicenseOptions = WebLicensePurchaseOptions;

/**
 * Offline Ed25519 desktop license key verifier for Tauri builds (§12.1, §15 Phase 8).
 */
export class TauriDesktopLicensePurchase extends WebLicensePurchase {}
