#!/usr/bin/env node
/**
 * Generates the Ed25519 key pair licence keys are signed with (§12.1, docs/licensing.md).
 *
 * Usage:
 *   node scripts/license-keygen.mjs --out <private-key-file>
 *
 * Writes the private key (PKCS#8 PEM, readable by its owner only) to <private-key-file>, which must
 * not exist yet and must lie outside this repository and every other git working tree. Prints
 * `VITE_LICENSE_PUBLIC_KEY=<64 hex characters>` on stdout. The private key is never printed.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const USAGE = 'Usage: node scripts/license-keygen.mjs --out <private-key-file>';

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when `dir` or a folder above it holds `.git` (a folder, or a worktree's file). */
function inGitWorkTree(dir) {
  if (existsSync(join(dir, '.git'))) return true;
  const parent = dirname(dir);
  return parent !== dir && inGitWorkTree(parent);
}

/** The real path to write to, or an error saying why the key must not go there. */
function privateKeyTarget(out) {
  const requested = resolve(out);
  let dir;
  try {
    // Resolve links first, so a link or junction cannot lead back into the repository.
    dir = realpathSync.native(dirname(requested));
  } catch {
    throw new Error(`The folder ${dirname(requested)} does not exist. Create it first.`);
  }
  const target = join(dir, basename(requested));
  if (isInside(REPO_ROOT, target) || inGitWorkTree(dir)) {
    throw new Error(
      `Refusing to write the private key inside a git repository (${target}). ` +
        'Choose a folder outside it, such as an offline drive.',
    );
  }
  // NOSONAR notes in this script: it writes where the owner's --out says, after the checks here,
  // and icacls gets that path as one argument with no shell.
  const taken = lstatSync(target, { throwIfNoEntry: false }); // NOSONAR (jssecurity:S8707)
  if (taken) {
    throw new Error(`Refusing to overwrite ${target}. Choose a new file name.`);
  }
  return target;
}

function runSystemTool(name, args) {
  const exe = join(process.env['SystemRoot'] ?? String.raw`C:\Windows`, 'System32', name);
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true }); // NOSONAR (jssecurity:S8705)
  if (result.status !== 0) throw new Error(`${name} failed`);
  return result.stdout;
}

/** Leaves the current user as the only one with access. Returns false when that cannot be done. */
function restrictToOwner(file) {
  // POSIX: the file was created with mode 0600.
  if (process.platform !== 'win32') return true;
  // Windows ignores the mode: replace the inherited access list with one entry for this user.
  try {
    const sid = /S-1-[\d-]+/.exec(runSystemTool('whoami.exe', ['/user', '/fo', 'csv', '/nh']));
    if (!sid) return false;
    runSystemTool('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid[0]}:F`]);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.out) throw new Error(`--out is required.\n${USAGE}`);
  const target = privateKeyTarget(values.out);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
    'hex',
  );

  // Create the file empty (`wx` never overwrites) and restrict it before the key goes in.
  writeFileSync(target, '', { flag: 'wx', mode: 0o600 }); // NOSONAR (jssecurity:S8707)
  let restricted;
  try {
    restricted = restrictToOwner(target);
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(target, pem, { flag: 'r+' }); // NOSONAR (jssecurity:S8707)
  } catch (err) {
    unlinkSync(target);
    throw err;
  }

  console.error(`Private key written to ${target}. Back it up and never commit or share it.`);
  if (!restricted) {
    console.error(
      'Warning: could not limit the file to your user account (some drives have no permissions). ' +
        'Move it somewhere only you can read.',
    );
  }
  console.log(`VITE_LICENSE_PUBLIC_KEY=${publicKeyHex}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
