import type { BrowserContext, Page } from '@playwright/test';

/**
 * Sets build overrides (`msClientId`, `dropboxAppKey`, `starterCatalog`, `licenseGate`,
 * `licensePubKey`). The production preview build ignores them in the URL and reads them only from
 * `window.__FLASH_TEST_QUERY__`, which this init script sets (S1, `apps/web/src/main.tsx`).
 * Calls add up, so several helpers can each set their own.
 */
export async function addTestOverrides(
  target: BrowserContext | Page,
  params: Record<string, string>,
): Promise<void> {
  await target.addInitScript((query) => {
    const w = window as unknown as { __FLASH_TEST_QUERY__?: string };
    w.__FLASH_TEST_QUERY__ = `${w.__FLASH_TEST_QUERY__ ?? ''}&${query}`;
  }, new URLSearchParams(params).toString());
}
