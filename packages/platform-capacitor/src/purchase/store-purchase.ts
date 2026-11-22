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

export interface StoreBillingPlugin {
  /** StoreKit 2 (iOS) or Play Billing v7 (Android) direct non-consumable purchase flow. */
  purchaseNonConsumable(productId: string): Promise<{ purchased: boolean; transactionId?: string }>;
  /** Queries current non-consumable entitlements directly from Apple App Store / Google Play. */
  queryEntitlements(): Promise<string[]>;
}

const STORE_ENTITLEMENT_KV_KEY = 'capacitor_store_entitlement_v1';

interface CachedStoreEntitlement {
  unlocked: boolean;
  transactionId?: string;
  verifiedAt: number;
}

const DEFAULT_STORE_LICENSE_PUBLIC_KEY =
  '2f5e6f8c0b4a9d3e7c1f2a4b6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a';

/**
 * StoreKit 2 / Google Play Billing non-consumable `unlock_full` adapter (§12.1, §15 Phase 8).
 * Caches verified purchase entitlement on-device so full unlock works 100% offline.
 */
export class CapacitorStorePurchase implements Purchase {
  readonly isPersonalBuild: boolean;
  private readonly storage: Storage;
  private readonly billingPlugin?: StoreBillingPlugin;
  private readonly publicKeyHex: string;
  private readonly cryptoProvider?: Ed25519CryptoProvider;

  constructor(options: {
    storage: Storage;
    isPersonalBuild?: boolean;
    billingPlugin?: StoreBillingPlugin;
    publicKeyHex?: string;
    cryptoProvider?: Ed25519CryptoProvider;
  }) {
    this.storage = options.storage;
    this.isPersonalBuild = options.isPersonalBuild ?? false;
    if (options.billingPlugin) this.billingPlugin = options.billingPlugin;
    this.publicKeyHex = options.publicKeyHex ?? DEFAULT_STORE_LICENSE_PUBLIC_KEY;
    if (options.cryptoProvider) this.cryptoProvider = options.cryptoProvider;
  }

  async getEntitlement(): Promise<EntitlementState> {
    if (this.isPersonalBuild) {
      return createPersonalEntitlement();
    }
    const cached = await this.storage.getKv<CachedStoreEntitlement>(STORE_ENTITLEMENT_KV_KEY);
    if (cached?.unlocked) {
      return {
        unlocked: true,
        source: 'store_iap',
        personalBuild: false,
        productId: UNLOCK_PRODUCT_ID,
        ...(cached.transactionId ? { keyId: cached.transactionId } : {}),
        verifiedAt: cached.verifiedAt,
      };
    }
    return createFreeTierEntitlement();
  }

  async isUnlocked(): Promise<boolean> {
    return (await this.getEntitlement()).unlocked;
  }

  async purchaseUnlock(): Promise<EntitlementState> {
    if (this.isPersonalBuild) return createPersonalEntitlement();
    if (!this.billingPlugin) {
      throw new Error('Native StoreKit 2 / Play Billing plugin is unavailable.');
    }
    const res = await this.billingPlugin.purchaseNonConsumable(UNLOCK_PRODUCT_ID);
    if (res.purchased) {
      const now = Date.now();
      await this.storage.setKv(STORE_ENTITLEMENT_KV_KEY, {
        unlocked: true,
        ...(res.transactionId ? { transactionId: res.transactionId } : {}),
        verifiedAt: now,
      } satisfies CachedStoreEntitlement);
      return {
        unlocked: true,
        source: 'store_iap',
        personalBuild: false,
        productId: UNLOCK_PRODUCT_ID,
        ...(res.transactionId ? { keyId: res.transactionId } : {}),
        verifiedAt: now,
      };
    }
    return this.getEntitlement();
  }

  async restore(): Promise<boolean> {
    const ent = await this.restorePurchases();
    return ent.unlocked;
  }

  async restorePurchases(): Promise<EntitlementState> {
    if (this.isPersonalBuild) return createPersonalEntitlement();
    if (this.billingPlugin) {
      const owned = await this.billingPlugin.queryEntitlements();
      if (owned.includes(UNLOCK_PRODUCT_ID)) {
        const now = Date.now();
        await this.storage.setKv(STORE_ENTITLEMENT_KV_KEY, {
          unlocked: true,
          transactionId: 'restored-store-entitlement',
          verifiedAt: now,
        } satisfies CachedStoreEntitlement);
      }
    }
    return this.getEntitlement();
  }

  async activateLicenseKey(
    rawKey: string,
  ): Promise<LicenseVerifyResult & { entitlement: EntitlementState }> {
    if (!this.cryptoProvider) {
      return {
        valid: false,
        reason: 'Ed25519 license key verifier not configured on store build.',
        entitlement: await this.getEntitlement(),
      };
    }
    const verified = await verifyEd25519LicenseKey(rawKey, this.publicKeyHex, this.cryptoProvider);
    if (!verified.valid || !verified.payload) {
      return { ...verified, entitlement: await this.getEntitlement() };
    }
    const now = Date.now();
    await this.storage.setKv(STORE_ENTITLEMENT_KV_KEY, {
      unlocked: true,
      transactionId: verified.payload.keyId,
      verifiedAt: now,
    } satisfies CachedStoreEntitlement);
    return {
      valid: true,
      payload: verified.payload,
      entitlement: await this.getEntitlement(),
    };
  }

  async clearLicenseKey(): Promise<EntitlementState> {
    await this.storage.deleteKv(STORE_ENTITLEMENT_KV_KEY);
    return this.getEntitlement();
  }
}
