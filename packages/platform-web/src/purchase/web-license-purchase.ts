import {
  createFreeTierEntitlement,
  createPersonalEntitlement,
  UNLOCK_PRODUCT_ID,
  verifyEd25519LicenseKey,
  type Ed25519CryptoProvider,
  type EntitlementState,
  type LicenseVerifyResult,
} from '@flash/core/license';
import type { Purchase, Storage } from '@flash/platform';

export const LICENSE_KV_KEY = 'license_entitlement_v1';

/**
 * The made-up key earlier builds shipped as their default (S12). It belongs to no signing key, so
 * it is treated exactly like no key at all.
 */
export const PLACEHOLDER_LICENSE_PUBLIC_KEY_HEX =
  '2f5e6f8c0b4a9d3e7c1f2a4b6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a';

/** Why a licence key is refused when the build carries no public key to check it against. */
export const LICENSE_PUBLIC_KEY_MISSING_REASON =
  'This build has no licence public key (VITE_LICENSE_PUBLIC_KEY), so licence keys cannot be checked.';

/**
 * The Ed25519 public key (hex, 32 bytes) licence keys are verified against (§12.1), or
 * `undefined` when none is configured or it is the old placeholder. Set at build time with
 * `VITE_LICENSE_PUBLIC_KEY`.
 */
export function usableLicensePublicKey(hex: string | undefined): string | undefined {
  const trimmed = hex?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(trimmed) || trimmed === PLACEHOLDER_LICENSE_PUBLIC_KEY_HEX) {
    return undefined;
  }
  return trimmed;
}

/** Says that licence keys cannot work, rather than failing closed in silence (S12). */
export function warnLicensePublicKeyMissing(): void {
  console.warn(`Licence gate is on but ${LICENSE_PUBLIC_KEY_MISSING_REASON}`);
}

export interface StoredLicenseRecord {
  rawKey: string;
  keyId: string;
  holder?: string;
  activatedAt: number;
}

export const webCryptoEd25519Provider: Ed25519CryptoProvider = {
  async verify(
    publicKeyRaw: Uint8Array,
    signature: Uint8Array,
    message: Uint8Array,
  ): Promise<boolean> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error('WebCrypto SubtleCrypto is unavailable for Ed25519 verification.');
    }
    const pubCopy = new Uint8Array(publicKeyRaw);
    const sigCopy = new Uint8Array(signature);
    const msgCopy = new Uint8Array(message);
    const key = await subtle.importKey('raw', pubCopy.buffer, 'Ed25519', false, ['verify']);
    return subtle.verify('Ed25519', key, sigCopy.buffer, msgCopy.buffer);
  },
};

export interface WebLicensePurchaseOptions {
  storage: Storage;
  isPersonalBuild?: boolean;
  publicKeyHex?: string;
  cryptoProvider?: Ed25519CryptoProvider;
  onStartCheckout?: () => void;
}

/**
 * Offline Ed25519 license-key & personal-build `Purchase` implementation (§12.1, §15 Phase 8).
 */
export class WebLicensePurchase implements Purchase {
  readonly isPersonalBuild: boolean;
  private readonly storage: Storage;
  private readonly publicKeyHex: string | undefined;
  private readonly cryptoProvider: Ed25519CryptoProvider;
  private readonly onStartCheckout?: () => void;

  constructor(options: WebLicensePurchaseOptions) {
    this.storage = options.storage;
    this.isPersonalBuild = options.isPersonalBuild ?? true;
    this.publicKeyHex = usableLicensePublicKey(options.publicKeyHex);
    if (!this.publicKeyHex && !this.isPersonalBuild) warnLicensePublicKeyMissing();
    this.cryptoProvider = options.cryptoProvider ?? webCryptoEd25519Provider;
    if (options.onStartCheckout) {
      this.onStartCheckout = options.onStartCheckout;
    }
  }

  async getEntitlement(): Promise<EntitlementState> {
    if (this.isPersonalBuild) {
      return createPersonalEntitlement();
    }
    const stored = await this.storage.getKv<StoredLicenseRecord>(LICENSE_KV_KEY);
    if (!stored?.rawKey || !this.publicKeyHex) {
      return createFreeTierEntitlement();
    }
    const verified = await verifyEd25519LicenseKey(
      stored.rawKey,
      this.publicKeyHex,
      this.cryptoProvider,
    );
    if (!verified.valid || !verified.payload) {
      return createFreeTierEntitlement();
    }
    return {
      unlocked: true,
      source: 'license_key',
      personalBuild: false,
      productId: UNLOCK_PRODUCT_ID,
      keyId: verified.payload.keyId,
      ...(verified.payload.holder !== undefined ? { holder: verified.payload.holder } : {}),
      verifiedAt: stored.activatedAt,
    };
  }

  async isUnlocked(): Promise<boolean> {
    const ent = await this.getEntitlement();
    return ent.unlocked;
  }

  async purchaseUnlock(): Promise<EntitlementState> {
    if (this.onStartCheckout) {
      this.onStartCheckout();
    }
    return this.getEntitlement();
  }

  async restore(): Promise<boolean> {
    return this.isUnlocked();
  }

  async restorePurchases(): Promise<EntitlementState> {
    return this.getEntitlement();
  }

  async activateLicenseKey(
    rawKey: string,
  ): Promise<LicenseVerifyResult & { entitlement: EntitlementState }> {
    if (!this.publicKeyHex) {
      return {
        valid: false,
        reason: LICENSE_PUBLIC_KEY_MISSING_REASON,
        entitlement: await this.getEntitlement(),
      };
    }
    const verified = await verifyEd25519LicenseKey(rawKey, this.publicKeyHex, this.cryptoProvider);
    if (!verified.valid || !verified.payload) {
      return {
        ...verified,
        entitlement: await this.getEntitlement(),
      };
    }
    const now = Date.now();
    const record: StoredLicenseRecord = {
      rawKey: rawKey.trim(),
      keyId: verified.payload.keyId,
      ...(verified.payload.holder !== undefined ? { holder: verified.payload.holder } : {}),
      activatedAt: now,
    };
    await this.storage.setKv(LICENSE_KV_KEY, record);
    return {
      valid: true,
      payload: verified.payload,
      entitlement: this.isPersonalBuild
        ? createPersonalEntitlement()
        : {
            unlocked: true,
            source: 'license_key',
            personalBuild: false,
            productId: UNLOCK_PRODUCT_ID,
            keyId: verified.payload.keyId,
            ...(verified.payload.holder !== undefined ? { holder: verified.payload.holder } : {}),
            verifiedAt: now,
          },
    };
  }

  async clearLicenseKey(): Promise<EntitlementState> {
    await this.storage.deleteKv(LICENSE_KV_KEY);
    return this.getEntitlement();
  }
}
