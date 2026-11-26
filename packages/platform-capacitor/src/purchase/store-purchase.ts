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
import {
  LICENSE_PUBLIC_KEY_MISSING_REASON,
  usableLicensePublicKey,
  warnLicensePublicKeyMissing,
} from '@flash/platform-web/purchase-license';

export interface StoreBillingPlugin {
  /** StoreKit 2 (iOS) or Play Billing v7 (Android) direct non-consumable purchase flow. */
  purchaseNonConsumable(productId: string): Promise<{ purchased: boolean; transactionId?: string }>;
  /** Queries current non-consumable entitlements directly from Apple App Store / Google Play. */
  queryEntitlements(): Promise<string[]>;
}

/** The fields of a `@capgo/native-purchases` transaction that say whether it is complete. */
export interface StoreTransactionState {
  transactionId?: string;
  /** Android only: `"1"` is PURCHASED, `"0"` is PENDING (e.g. a cash payment not yet made). */
  purchaseState?: string;
  /** iOS only: set when Apple revoked the transaction (a refund). */
  revocationDate?: string;
  isActive?: boolean;
  /** Android only: Play refunds a purchase that isn't acknowledged within 3 days. */
  isAcknowledged?: boolean;
  /** Android only: the token `acknowledgePurchase` takes. */
  purchaseToken?: string;
}

/**
 * True for a purchase that should unlock: it has a transaction, and on Android its payment has
 * cleared (S8: a pending Play purchase used to unlock at once), and on iOS it isn't revoked.
 */
export function isCompletedStorePurchase(tx: StoreTransactionState): boolean {
  if (!tx.transactionId) return false;
  if (tx.purchaseState !== undefined && tx.purchaseState !== '1') return false;
  return !tx.revocationDate && tx.isActive !== false;
}

/**
 * Tokens of completed Play purchases nobody acknowledged yet: a purchase that was still pending at
 * checkout clears later, outside the purchase flow that acknowledges it, and Play refunds it after
 * 3 days unless the app acknowledges it.
 */
export function unacknowledgedPlayTokens(txs: readonly StoreTransactionState[]): string[] {
  return txs
    .filter((tx) => isCompletedStorePurchase(tx) && tx.isAcknowledged === false)
    .flatMap((tx) => (tx.purchaseToken ? [tx.purchaseToken] : []));
}

const STORE_ENTITLEMENT_KV_KEY = 'capacitor_store_entitlement_v1';
const RESTORED_TRANSACTION_ID = 'restored-store-entitlement';

interface CachedStoreEntitlement {
  unlocked: boolean;
  transactionId?: string;
  verifiedAt: number;
  /** What unlocked this device. Only a store unlock is the store's to take back (S8). */
  via?: 'store' | 'license_key';
}

/**
 * Entries saved before S8 have no `via`. Only Restore Purchases wrote a fixed transaction id, so
 * that one is a store unlock; any other is treated as a licence key, which is never re-checked
 * (no screen started a store purchase before S8).
 */
function isStoreUnlock(cached: CachedStoreEntitlement): boolean {
  return cached.via ? cached.via === 'store' : cached.transactionId === RESTORED_TRANSACTION_ID;
}

/** Why a store build refuses licence keys while `allowLicenseKeys` is off (the default). */
export const STORE_LICENSE_KEYS_OFF_REASON =
  'Licence keys are not accepted in the App Store / Google Play build; unlock it through the store.';

/**
 * StoreKit 2 / Google Play Billing non-consumable `unlock_full` adapter (§12.1, §15 Phase 8).
 * Caches verified purchase entitlement on-device so full unlock works 100% offline.
 */
export class CapacitorStorePurchase implements Purchase {
  readonly isPersonalBuild: boolean;
  private readonly storage: Storage;
  private readonly billingPlugin?: StoreBillingPlugin;
  private readonly publicKeyHex: string | undefined;
  private readonly cryptoProvider?: Ed25519CryptoProvider;
  private readonly allowLicenseKeys: boolean;

  constructor(options: {
    storage: Storage;
    isPersonalBuild?: boolean;
    billingPlugin?: StoreBillingPlugin;
    publicKeyHex?: string;
    cryptoProvider?: Ed25519CryptoProvider;
    /**
     * Lets a licence key bought outside the App Store / Play unlock this store build. Off by
     * default: store rules (App Store guideline 3.1.1) restrict that, so it is the owner's call.
     */
    allowLicenseKeys?: boolean;
  }) {
    this.storage = options.storage;
    this.isPersonalBuild = options.isPersonalBuild ?? false;
    if (options.billingPlugin) this.billingPlugin = options.billingPlugin;
    this.publicKeyHex = usableLicensePublicKey(options.publicKeyHex);
    if (options.cryptoProvider) this.cryptoProvider = options.cryptoProvider;
    this.allowLicenseKeys = options.allowLicenseKeys ?? false;
    // Only a build that offers licence keys needs the key; the normal IAP build stays quiet.
    if (this.allowLicenseKeys && !this.publicKeyHex && !this.isPersonalBuild) {
      warnLicensePublicKeyMissing();
    }
  }

  async getEntitlement(): Promise<EntitlementState> {
    if (this.isPersonalBuild) {
      return createPersonalEntitlement();
    }
    const cached = await this.readCache();
    if (cached?.unlocked) {
      return {
        unlocked: true,
        source: isStoreUnlock(cached) ? 'store_iap' : 'license_key',
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
      await this.storage.setKv(STORE_ENTITLEMENT_KV_KEY, {
        unlocked: true,
        via: 'store',
        ...(res.transactionId ? { transactionId: res.transactionId } : {}),
        verifiedAt: Date.now(),
      } satisfies CachedStoreEntitlement);
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
      await this.applyStoreAnswer(await this.billingPlugin.queryEntitlements());
    }
    return this.getEntitlement();
  }

  /**
   * Run at launch (S8): asks the store again, so a refunded or revoked store unlock locks and a
   * store purchase on a fresh install unlocks. A licence key is left alone, and a store check that
   * fails (offline, no store account) changes nothing.
   */
  async recheckStore(): Promise<EntitlementState> {
    if (this.isPersonalBuild || !this.billingPlugin) return this.getEntitlement();
    const cached = await this.readCache();
    if (cached?.unlocked && !isStoreUnlock(cached)) return this.getEntitlement();
    let owned: string[];
    try {
      owned = await this.billingPlugin.queryEntitlements();
    } catch {
      return this.getEntitlement();
    }
    await this.applyStoreAnswer(owned);
    return this.getEntitlement();
  }

  private readCache(): Promise<CachedStoreEntitlement | undefined> {
    return this.storage.getKv<CachedStoreEntitlement>(STORE_ENTITLEMENT_KV_KEY);
  }

  /** Makes the cached store unlock match what the store owns. A licence key is never touched. */
  private async applyStoreAnswer(owned: readonly string[]): Promise<void> {
    const cached = await this.readCache();
    if (cached?.unlocked && !isStoreUnlock(cached)) return;
    if (owned.includes(UNLOCK_PRODUCT_ID)) {
      await this.storage.setKv(STORE_ENTITLEMENT_KV_KEY, {
        unlocked: true,
        via: 'store',
        transactionId: cached?.transactionId ?? RESTORED_TRANSACTION_ID,
        verifiedAt: Date.now(),
      } satisfies CachedStoreEntitlement);
    } else if (cached) {
      await this.storage.deleteKv(STORE_ENTITLEMENT_KV_KEY);
    }
  }

  async activateLicenseKey(
    rawKey: string,
  ): Promise<LicenseVerifyResult & { entitlement: EntitlementState }> {
    if (!this.allowLicenseKeys) {
      return {
        valid: false,
        reason: STORE_LICENSE_KEYS_OFF_REASON,
        entitlement: await this.getEntitlement(),
      };
    }
    if (!this.publicKeyHex || !this.cryptoProvider) {
      return {
        valid: false,
        reason: this.publicKeyHex
          ? 'Ed25519 license key verifier not configured on store build.'
          : LICENSE_PUBLIC_KEY_MISSING_REASON,
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
      via: 'license_key',
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
