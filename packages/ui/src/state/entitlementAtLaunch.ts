import type { Purchase } from '@flash/platform';

/**
 * Launch: show the cached entitlement at once, then (App Store / Play builds) ask the store again
 * and show its answer, so a refunded unlock locks (S8). A store check that throws changes nothing.
 */
export async function refreshThenRecheckStore(
  getPurchase: (() => Promise<Purchase>) | undefined,
  refresh: () => Promise<unknown>,
): Promise<void> {
  await refresh();
  try {
    const purchase = await getPurchase?.();
    if (!purchase?.recheckStore) return;
    await purchase.recheckStore();
  } catch {
    return;
  }
  await refresh();
}
