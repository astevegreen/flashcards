// `license-keygen.mjs` and `license-sign.mjs`, run as the owner runs them, checked against the app's
// own verifier. Every key pair is throwaway, made in a temporary folder.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  usableLicensePublicKey,
  WebLicensePurchase,
} from '../../packages/platform-web/src/purchase/web-license-purchase.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (script, ...args) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { encoding: 'utf8' });
const keygen = (...args) => run('license-keygen.mjs', ...args);
const sign = (...args) => run('license-sign.mjs', ...args);

let tmp;
let keyFile;
let generated;
let publicKeyHex;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'flash-license-'));
  keyFile = join(tmp, 'flash-license-private-key.pem');
  generated = keygen('--out', keyFile);
  publicKeyHex = generated.stdout.trim().split('=')[1];
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A gated build holding `hex` as its public key, as the app constructs it. */
function gatedPurchase(hex = publicKeyHex) {
  const kv = new Map();
  const storage = {
    getKv: async (key) => kv.get(key),
    setKv: async (key, value) => void kv.set(key, value),
    deleteKv: async (key) => void kv.delete(key),
  };
  return new WebLicensePurchase({ storage, isPersonalBuild: false, publicKeyHex: hex });
}

function signedKey(...args) {
  const res = sign('--key', keyFile, '--key-id', 'lic-0001', ...args);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.trim();
}

describe('license-keygen', () => {
  it('prints only the public key, as the app reads VITE_LICENSE_PUBLIC_KEY', () => {
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stdout).toMatch(/^VITE_LICENSE_PUBLIC_KEY=[0-9a-f]{64}\n$/);
    expect(usableLicensePublicKey(publicKeyHex)).toBe(publicKeyHex);
  });

  it('writes the private key to the file and never prints it', () => {
    const [header, body] = readFileSync(keyFile, 'utf8').split('\n');
    expect(header).toBe('-----BEGIN PRIVATE KEY-----');
    const output = generated.stdout + generated.stderr;
    expect(output).not.toContain('PRIVATE KEY');
    expect(output).not.toContain(body);
  });

  it('leaves the file readable by its owner only', () => {
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls', [keyFile], { encoding: 'utf8' }).stdout;
      // One access entry, "<account>:(F)", and none inherited from the folder.
      expect(acl.match(/:\(/g)).toHaveLength(1);
      expect(acl).not.toContain('(I)');
      expect(generated.stderr).not.toContain('Warning');
    } else {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(generated.stderr).not.toContain('Warning');
    }
  });

  it('warns on POSIX when the drive leaves the file open to others', () => {
    // No such drive here: a preload plays a POSIX system whose `stat` reports mode 0644.
    const preload = join(tmp, 'open-mode.mjs');
    writeFileSync(
      preload,
      [
        "import fs from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "Object.defineProperty(process, 'platform', { value: 'linux' });",
        'const statSync = fs.statSync;',
        'fs.statSync = (...args) => Object.assign(statSync(...args), { mode: 0o100644 });',
        'syncBuiltinESMExports();',
      ].join('\n'),
    );
    const res = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        join(ROOT, 'scripts', 'license-keygen.mjs'),
        '--out',
        join(tmp, 'open.pem'),
      ],
      { encoding: 'utf8' },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('Warning: could not limit the file to your user account');
  });

  it('refuses to overwrite a file', () => {
    const before = readFileSync(keyFile, 'utf8');
    const res = keygen('--out', keyFile);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Refusing to overwrite');
    expect(res.stdout).toBe('');
    expect(readFileSync(keyFile, 'utf8')).toBe(before);
  });

  function expectRefusedInRepo(out) {
    const res = keygen('--out', out);
    const written = existsSync(out);
    if (written) rmSync(out);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('inside a git repository');
    expect(written).toBe(false);
  }

  it('refuses to write inside this repository, also through a link', () => {
    expectRefusedInRepo(join(ROOT, 'flash-license-private-key.pem'));
    expectRefusedInRepo(join(ROOT, 'scripts', 'flash-license-private-key.pem'));
    const link = join(tmp, 'link-into-repo');
    // A junction needs no special rights on Windows; elsewhere the type is ignored.
    symlinkSync(join(ROOT, 'scripts'), link, 'junction');
    expectRefusedInRepo(join(link, 'flash-license-private-key.pem'));
    rmSync(link, { force: true, recursive: false });
  });

  it('refuses to write inside any other git working tree', () => {
    const other = join(tmp, 'other-checkout');
    mkdirSync(join(other, 'nested'), { recursive: true });
    writeFileSync(join(other, '.git'), 'gitdir: elsewhere\n');
    expectRefusedInRepo(join(other, 'nested', 'key.pem'));
  });

  it('needs --out, and a folder that exists', () => {
    expect(keygen().stderr).toContain('--out is required');
    const res = keygen('--out', join(tmp, 'missing', 'key.pem'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('does not exist');
  });
});

describe('license-sign round trip against the app verifier', () => {
  it('issues a key that unlocks a build carrying the public key', async () => {
    const key = signedKey(
      '--holder',
      ' 홍길동 <learner@example.test> ',
      '--issued-at',
      '2026-11-26',
    );
    expect(key).toMatch(/^FLASH1\.[\w-]+\.[\w-]+$/);
    const purchase = gatedPurchase();
    const res = await purchase.activateLicenseKey(key);
    expect(res.reason).toBeUndefined();
    expect(res.payload).toEqual({
      v: 1,
      product: 'flashcards-unlock-v1',
      edition: 'lifetime',
      keyId: 'lic-0001',
      issuedAt: Date.UTC(2026, 10, 26),
      holder: '홍길동 <learner@example.test>',
    });
    expect(await purchase.getEntitlement()).toMatchObject({
      unlocked: true,
      source: 'license_key',
      keyId: 'lic-0001',
    });
  });

  it('defaults to the current time and no holder', async () => {
    const before = Date.now();
    const { payload } = await gatedPurchase().activateLicenseKey(signedKey());
    expect(payload.issuedAt).toBeGreaterThanOrEqual(before);
    expect(payload.issuedAt).toBeLessThanOrEqual(Date.now());
    expect(payload).not.toHaveProperty('holder');
  });

  it('reports the public key the licence verifies against, and never the private key', () => {
    const res = sign('--key', keyFile, '--key-id', 'lic-0002');
    expect(res.stderr).toContain(publicKeyHex);
    const body = readFileSync(keyFile, 'utf8').split('\n')[1];
    expect(res.stdout + res.stderr).not.toContain(body);
  });

  it('the app refuses a tampered payload or signature', async () => {
    const [prefix, payload, signature] = signedKey().split('.');
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const forged = Buffer.from(json.replace('lic-0001', 'lic-9999')).toString('base64url');
    const bytes = Buffer.from(signature, 'base64url');
    bytes[0] ^= 1;
    for (const tampered of [
      `${prefix}.${forged}.${signature}`,
      `${prefix}.${payload}.${bytes.toString('base64url')}`,
    ]) {
      const res = await gatedPurchase().activateLicenseKey(tampered);
      expect(res.reason).toBe('Ed25519 license signature verification failed.');
      expect(res.entitlement.unlocked).toBe(false);
    }
  });

  it('a build with a rotated public key refuses keys signed by the old private key', async () => {
    const next = keygen('--out', join(tmp, 'rotated.pem'));
    const rotated = gatedPurchase(next.stdout.trim().split('=')[1]);
    const res = await rotated.activateLicenseKey(signedKey());
    expect(res.valid).toBe(false);
    expect(res.entitlement.unlocked).toBe(false);
  });
});

describe('license-sign input checks', () => {
  function expectRefused(args, message) {
    const res = sign(...args);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain(message);
  }

  it('needs a private-key file and a key ID, and no blank holder', () => {
    expectRefused(['--key-id', 'a'], 'are required');
    expectRefused(['--key', keyFile, '--key-id', '  '], 'are required');
    expectRefused(['--key', keyFile, '--key-id', 'a', '--holder', ' '], 'must not be blank');
  });

  it('refuses a date that is not a real YYYY-MM-DD', () => {
    for (const date of ['26/11/2026', '2026-02-30', '2026-11-26T10:00', 'today']) {
      expectRefused(['--key', keyFile, '--key-id', 'a', '--issued-at', date], 'YYYY-MM-DD');
    }
  });

  it('refuses a missing, unreadable or non-Ed25519 key file without echoing it', () => {
    expectRefused(['--key', join(tmp, 'absent.pem'), '--key-id', 'a'], 'ENOENT');
    const junk = join(tmp, 'junk.pem');
    writeFileSync(junk, 'not-a-key-secret-text');
    const res = sign('--key', junk, '--key-id', 'a');
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain('not-a-key-secret-text');
    const rsa = join(tmp, 'rsa.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(rsa, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expectRefused(['--key', rsa, '--key-id', 'a'], 'not an Ed25519');
  });
});
