import { describe, expect, it } from 'vitest';
import { isCompletedStorePurchase } from '../src/purchase/store-purchase.ts';

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
});
