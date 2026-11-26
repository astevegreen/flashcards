import { encodeLicenseKey } from '@flash/core/license';
import { describe, expect, it, vi } from 'vitest';
import { CapacitorSqliteStorage } from '../src/index.ts';
import {
  CapacitorStorePurchase,
  isCompletedStorePurchase,
  unacknowledgedPlayTokens,
  type StoreBillingPlugin,
} from '../src/purchase/store-purchase.ts';
import { InMemorySqliteDriver } from './support/in-memory-sqlite-driver.ts';

describe('store purchases unlock only once they are complete (S8)', () => {
  it('a Play purchase still pending payment does not count', () => {
    expect(isCompletedStorePurchase({ transactionId: 'GPA.1', purchaseState: '0' })).toBe(false);
    expect(isCompletedStorePurchase({ transactionId: 'GPA.1', purchaseState: '2' })).toBe(false);
    expect(isCompletedStorePurchase({ transactionId: 'GPA.1', purchaseState: '1' })).toBe(true);
  });

  it('an App Store transaction (no purchaseState) counts unless revoked', () => {
    expect(isCompletedStorePurchase({ transactionId: '2000001' })).toBe(true);
    expect(
      isCompletedStorePurchase({
        transactionId: '2000001',
        revocationDate: '2026-11-20T00:00:00Z',
      }),
    ).toBe(false);
    expect(isCompletedStorePurchase({ transactionId: '2000001', isActive: false })).toBe(false);
  });

  it('no transaction id means no purchase', () => {
    expect(isCompletedStorePurchase({ purchaseState: '1' })).toBe(false);
    expect(isCompletedStorePurchase({ transactionId: '' })).toBe(false);
  });

  it('a Play purchase that cleared after checkout still needs acknowledging', () => {
    expect(
      unacknowledgedPlayTokens([
        {
          transactionId: 'GPA.1',
          purchaseState: '1',
          isAcknowledged: false,
          purchaseToken: 'tok-1',
        },
        {
          transactionId: 'GPA.2',
          purchaseState: '1',
          isAcknowledged: true,
          purchaseToken: 'tok-2',
        },
        {
          transactionId: 'GPA.3',
          purchaseState: '0',
          isAcknowledged: false,
          purchaseToken: 'tok-3',
        },
        { transactionId: '2000001' },
      ]),
    ).toEqual(['tok-1']);
  });
});

/** A store whose answer the test changes between "launches". */
function fakeStore(initial: string[] | Error) {
  let answer: string[] | Error = initial;
  const queryEntitlements = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const plugin: StoreBillingPlugin = {
    purchaseNonConsumable: async () => ({ purchased: true, transactionId: 'GPA.42' }),
    queryEntitlements,
  };
  return {
    plugin,
    queryEntitlements,
    answer: (next: string[] | Error) => {
      answer = next;
    },
  };
}

function storePurchase(storage: CapacitorSqliteStorage, plugin: StoreBillingPlugin) {
  return new CapacitorStorePurchase({
    storage,
    billingPlugin: plugin,
    // Any well-formed key that is not the old placeholder; the fake provider accepts every signature.
    publicKeyHex: 'ab'.repeat(32),
    cryptoProvider: { verify: async () => true },
  });
}

const LICENCE_KEY = encodeLicenseKey(
  {
    v: 1,
    product: 'flashcards-unlock-v1',
    edition: 'lifetime',
    keyId: 'KEY-7',
    issuedAt: 1_700_000_000_000,
  },
  new Uint8Array(64),
);

describe('the store is asked again at launch (S8)', () => {
  it('a refunded store purchase locks at the next launch', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = fakeStore(['unlock_full']);
    expect((await storePurchase(storage, store.plugin).purchaseUnlock()).unlocked).toBe(true);

    store.answer([]);
    const relaunched = storePurchase(storage, store.plugin);
    const ent = await relaunched.recheckStore();
    expect(ent.unlocked).toBe(false);
    expect(ent.source).toBe('free');
    expect((await relaunched.getEntitlement()).unlocked).toBe(false);
  });

  it('a store check that fails (offline) keeps the unlock', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = fakeStore(['unlock_full']);
    await storePurchase(storage, store.plugin).purchaseUnlock();

    store.answer(new Error('Billing service unavailable'));
    const ent = await storePurchase(storage, store.plugin).recheckStore();
    expect(ent.unlocked).toBe(true);
    expect(ent.source).toBe('store_iap');
  });

  it('a purchase the store still lists stays unlocked', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = fakeStore(['unlock_full']);
    await storePurchase(storage, store.plugin).purchaseUnlock();

    const ent = await storePurchase(storage, store.plugin).recheckStore();
    expect(ent.unlocked).toBe(true);
    expect(ent.keyId).toBe('GPA.42');
  });

  it('a purchase the store lists on a fresh install unlocks without tapping Restore', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = fakeStore(['unlock_full']);
    const ent = await storePurchase(storage, store.plugin).recheckStore();
    expect(ent.unlocked).toBe(true);
    expect(ent.source).toBe('store_iap');
  });

  it('a licence key stays unlocked and the store is not asked about it', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = fakeStore([]);
    const activated = await storePurchase(storage, store.plugin).activateLicenseKey(LICENCE_KEY);
    expect(activated.valid).toBe(true);
    expect(activated.entitlement.source).toBe('license_key');

    const ent = await storePurchase(storage, store.plugin).recheckStore();
    expect(ent.unlocked).toBe(true);
    expect(ent.source).toBe('license_key');
    expect(ent.keyId).toBe('KEY-7');
    expect(store.queryEntitlements).not.toHaveBeenCalled();
  });

  it('Restore Purchases does not turn a licence key into a store unlock', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = fakeStore(['unlock_full']);
    const purchase = storePurchase(storage, store.plugin);
    await purchase.activateLicenseKey(LICENCE_KEY);
    await purchase.restorePurchases();

    store.answer([]);
    const ent = await storePurchase(storage, store.plugin).recheckStore();
    expect(ent.unlocked).toBe(true);
    expect(ent.source).toBe('license_key');
  });

  it('an unlock saved before this change: a restored one is re-checked, a key is kept', async () => {
    const restored = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    await restored.setKv('capacitor_store_entitlement_v1', {
      unlocked: true,
      transactionId: 'restored-store-entitlement',
      verifiedAt: 1,
    });
    const store = fakeStore([]);
    expect((await storePurchase(restored, store.plugin).recheckStore()).unlocked).toBe(false);

    const keyed = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    await keyed.setKv('capacitor_store_entitlement_v1', {
      unlocked: true,
      transactionId: 'KEY-7',
      verifiedAt: 1,
    });
    const ent = await storePurchase(keyed, store.plugin).recheckStore();
    expect(ent.unlocked).toBe(true);
    expect(ent.source).toBe('license_key');
  });

  it('a personal build never asks the store', async () => {
    const store = fakeStore([]);
    const purchase = new CapacitorStorePurchase({
      storage: new CapacitorSqliteStorage(new InMemorySqliteDriver()),
      isPersonalBuild: true,
      billingPlugin: store.plugin,
    });
    expect((await purchase.recheckStore()).personalBuild).toBe(true);
    expect(store.queryEntitlements).not.toHaveBeenCalled();
  });
});
