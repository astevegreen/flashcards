import { webcrypto } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  canonicalLicenseMessage,
  encodeLicenseKey,
} from '../../packages/core/src/license/index.ts';
import { addTestOverrides } from './helpers/test-overrides.ts';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test.describe('Phase 8 Licensing, Sunset Promise & Native Picker Bridge E2E (§11, §12)', () => {
  test('Personal build displays Unlocked status & Sunset Promise in Settings', async ({ page }) => {
    await page.goto('/?device=p8personal');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).first().click();
    const card = page.getByTestId('unlock-sunset-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('license-status-badge')).toContainText(
      'Personal / Family Build (Unlocked)',
    );
    await expect(card).toContainText('Sunset Promise (§12.2)');
    await expect(card).toContainText('keep working offline forever');
  });

  test('A link cannot turn on the licence gate or swap its key in a production build (S1)', async ({
    page,
  }) => {
    await page.goto(`/?device=p8link&licenseGate=1&licensePubKey=${'ab'.repeat(32)}`);
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('license-status-badge')).toContainText(
      'Personal / Family Build (Unlocked)',
    );
  });

  test('Commercial license gate: rejects invalid key, verifies Ed25519 key offline, persists across reload', async ({
    page,
    context,
  }) => {
    const pair = (await webcrypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKeyHex = bytesToHex(
      new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)),
    );
    const payload = {
      v: 1 as const,
      product: 'flashcards-unlock-v1' as const,
      edition: 'lifetime' as const,
      keyId: 'e2e-lifetime-001',
      issuedAt: 1_760_000_000_000,
      holder: 'learner@example.test',
    };
    const provisional = encodeLicenseKey(payload, new Uint8Array(64));
    const msg = canonicalLicenseMessage(provisional.split('.')[1] ?? '');
    const sig = new Uint8Array(
      await webcrypto.subtle.sign('Ed25519', pair.privateKey, new Uint8Array(msg).buffer),
    );
    const validKey = encodeLicenseKey(payload, sig);

    await addTestOverrides(page, { licenseGate: '1', licensePubKey: publicKeyHex });
    const gatedUrl = '/?device=p8gate';
    await page.goto(gatedUrl);
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Ensure Service Worker precached before offline activation test
    const hasController = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return true;
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });
    if (!hasController) {
      await page.reload();
      await page.evaluate(async () => {
        if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
      });
    }

    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('license-status-badge')).toContainText('Free Starter Tier');

    // Cloud sync is gated on the commercial free tier
    await page.getByTestId('sync-now-btn').click();
    await expect(page.getByRole('alert')).toContainText(
      'Cloud sync requires the one-time Unlock upgrade',
    );

    // Creating a new deck beyond FREE_TIER_MAX_DECKS (2) is gated on the commercial free tier
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByPlaceholder('Deck name (e.g., TOPIK II Verbs)').fill('Blocked Free Deck');
    await page.getByRole('button', { name: 'Create Deck' }).click();
    await expect(page.getByRole('alert')).toContainText('Free tier supports up to 2 local decks');

    // Invalid key rejected
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('license-key-input').fill('FLASH1.invalid.sig');
    await page.getByTestId('license-activate-btn').click();
    await expect(page.getByTestId('license-error')).toBeVisible();

    // Valid Ed25519 key activates offline with zero network calls
    await context.setOffline(true);
    await page.getByTestId('license-key-input').fill(validKey);
    await page.getByTestId('license-activate-btn').click();
    await expect(page.getByTestId('license-feedback')).toContainText('e2e-lifetime-001');
    await expect(page.getByTestId('license-status-badge')).toContainText('Unlocked (Ed25519 Key)');

    // Once unlocked offline, creating unlimited decks in Library succeeds immediately
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByPlaceholder('Deck name (e.g., TOPIK II Verbs)').fill('Unlocked Custom Deck');
    await page.getByRole('button', { name: 'Create Deck' }).click();
    await expect(page.getByTestId('library-status')).toContainText(
      'Created deck "Unlocked Custom Deck"',
    );

    // Reload offline and confirm entitlement persisted
    await page.reload();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('license-status-badge')).toContainText('Unlocked (Ed25519 Key)');

    // Deactivate key restores free tier
    await page.getByTestId('license-clear-btn').click();
    await expect(page.getByTestId('license-status-badge')).toContainText('Free Starter Tier');

    await context.setOffline(false);
  });

  test('In-app Deck & Note Archive and Restore lifecycle preserves data', async ({ page }) => {
    await page.goto('/?device=p8archive');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Archive current note via Edit Note dialog
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByTestId('archive-note-btn').click();

    // Verify note appears in Browse -> Archived (1) and can be restored in 1 tap
    await page.getByRole('button', { name: 'Words' }).first().click();
    const archivedFilter = page.getByTestId('archived-notes-filter');
    await expect(archivedFilter).toContainText('Archived (1)');
    await archivedFilter.click();
    const restoreNoteBtn = page.locator('[data-testid^="browse-restore-note-"]').first();
    await expect(restoreNoteBtn).toBeVisible();
    await restoreNoteBtn.click();
    await expect(archivedFilter).toContainText('Archived (0)');

    // Archive a deck in Library -> Options -> Archive Deck, then restore it
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByRole('button', { name: 'Options' }).first().click();
    await page.locator('[data-testid^="archive-deck-btn-"]').first().click();
    await expect(page.getByTestId('library-status')).toContainText('Archived deck');
    await expect(page.getByTestId('archived-decks-panel')).toBeVisible();
    await page.getByTestId('toggle-archived-decks-btn').click();
    await page.locator('[data-testid^="restore-deck-btn-"]').first().click();
    await expect(page.getByTestId('library-status')).toContainText('Restored deck');
  });

  test('Static native Google Picker bridge page (/picker.html) validates parameters safely', async ({
    page,
  }) => {
    await page.goto('/picker.html');
    await expect(page.locator('#status')).toContainText('Missing required Picker authorization');

    await page.goto('/picker.html?check=1#callback=javascript:alert(1)');
    await expect(page.locator('#status')).toContainText('Invalid deep-link callback target');
  });
});
