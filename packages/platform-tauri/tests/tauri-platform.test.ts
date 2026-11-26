import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalLicenseMessage, encodeLicenseKey } from '../../core/src/license/index.ts';
import {
  createTauriPlatform,
  TauriDesktopLicensePurchase,
  TauriFolderSyncTransport,
  TauriGoogleAuth,
  TauriLocalFolderWatcher,
  TauriSqliteStorage,
  type TauriFsBridge,
} from '../src/index.ts';
import { memoryTauriDb } from './support/memory-tauri-db.ts';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Phase 8 Tauri Desktop Platform Adapters (§3.2, §4.3, §12.1)', () => {
  it('TauriLocalFolderWatcher scans folder, detects Inbox/, moves to imported/, and watches changes', async () => {
    const fsData = new Map<string, Uint8Array>([
      ['/notes/vocab.csv', new TextEncoder().encode('Word,Meaning\n나무,tree\n')],
      ['/notes/Inbox/new-cards.csv', new TextEncoder().encode('Word,Meaning\n별,star\n')],
      ['/notes/Inbox/imported/old.csv', new TextEncoder().encode('Word,Meaning\n달,moon\n')],
    ]);
    let watchCb: ((paths: string[]) => void) | undefined;

    const bridge: TauriFsBridge = {
      pickDirectory: async () => ({ path: '/notes', name: 'Flashcards Folder' }),
      listDirectoryFiles: async (root) =>
        [...fsData.entries()]
          .filter(([k]) => k.startsWith(`${root}/`))
          .map(([abs, b]) => {
            const rel = abs.slice(root.length + 1);
            return {
              relativePath: rel,
              name: rel.split('/').pop() ?? rel,
              size: b.byteLength,
              lastModified: 1000,
            };
          }),
      readFileBytes: async (abs) => {
        const b = fsData.get(abs);
        if (!b) throw new Error(`Missing ${abs}`);
        return b;
      },
      writeFileBytes: async (abs, data, opts) => {
        if (opts?.ifAbsent && fsData.has(abs)) return;
        fsData.set(abs, data);
      },
      moveFile: async (from, to) => {
        const b = fsData.get(from);
        if (b) {
          fsData.delete(from);
          fsData.set(to, b);
        }
      },
      watchDirectory: (_root, onChange) => {
        watchCb = onChange;
        return () => {
          watchCb = undefined;
        };
      },
    };

    const storage = new TauriSqliteStorage(memoryTauriDb());
    const watcher = new TauriLocalFolderWatcher({ storage, bridge });
    const picked = await watcher.pickFolder();
    expect(picked).toEqual({ id: 'tauri-folder:/notes', name: 'Flashcards Folder' });

    const files = await watcher.listFolderFiles('tauri-folder:/notes');
    expect(files.map((f) => f.relativePath)).toEqual(['Inbox/new-cards.csv', 'vocab.csv']);
    expect(files[0]?.isInbox).toBe(true);

    expect(await watcher.moveInboxFileToImported('tauri-folder:/notes', 'new-cards.csv')).toBe(
      true,
    );
    expect(fsData.has('/notes/Inbox/imported/new-cards.csv')).toBe(true);

    const observed: string[][] = [];
    const unwatch = await watcher.watchFolder('tauri-folder:/notes', (p) => observed.push(p));
    watchCb?.(['/notes/vocab.csv']);
    expect(observed).toEqual([['/notes/vocab.csv']]);
    unwatch();

    // TauriFolderSyncTransport
    const syncTransport = new TauriFolderSyncTransport('/sync', {
      ...bridge,
      listDirectoryFiles: async () => [
        { relativePath: 'sync/v1/manifest.json', name: 'manifest.json', size: 2, lastModified: 1 },
      ],
    });
    expect((await syncTransport.list('sync/v1')).length).toBe(1);
  });

  it('TauriDesktopLicensePurchase activates offline Ed25519 keys and TauriGoogleAuth signs in without Worker', async () => {
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
      keyId: 'desktop-key-42',
      issuedAt: 1_760_000_000_000,
    };
    const provisional = encodeLicenseKey(payload, new Uint8Array(64));
    const msg = canonicalLicenseMessage(provisional.split('.')[1] ?? '');
    const sig = new Uint8Array(
      await webcrypto.subtle.sign('Ed25519', pair.privateKey, new Uint8Array(msg).buffer),
    );
    const signedKey = encodeLicenseKey(payload, sig);

    const storage = new TauriSqliteStorage(memoryTauriDb());
    const purchase = new TauriDesktopLicensePurchase({
      storage,
      isPersonalBuild: false,
      publicKeyHex,
    });
    expect(await purchase.isUnlocked()).toBe(false);
    const res = await purchase.activateLicenseKey(signedKey);
    expect(res.valid).toBe(true);
    expect(res.entitlement.unlocked).toBe(true);
    expect(res.entitlement.keyId).toBe('desktop-key-42');

    const auth = new TauriGoogleAuth({
      storage,
      clientId: 'desktop-client-id',
      plugin: {
        authorizeWithSystemBrowser: async () => ({
          accessToken: 'loopback-tok',
          expiresInSeconds: 3600,
        }),
        refreshAccessToken: async () => ({
          accessToken: 'loopback-tok-2',
          expiresInSeconds: 3600,
        }),
        revokeSession: async () => undefined,
      },
    });
    expect((await auth.signIn())?.accessToken).toBe('loopback-tok');

    const tauriPlatform = createTauriPlatform({
      sqlDb: memoryTauriDb(),
      deviceId: 'tauri-pc-1',
      isPersonalBuild: true,
    });
    expect(await (await tauriPlatform.getPurchase?.())?.isUnlocked()).toBe(true);
  });
});
