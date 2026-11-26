#!/usr/bin/env node
/**
 * Issues a licence key signed with the private key from `license-keygen.mjs` (docs/licensing.md).
 *
 * Usage:
 *   node scripts/license-sign.mjs --key <private-key-file> --key-id <id>
 *       [--holder <name or email>] [--issued-at <YYYY-MM-DD>]
 *
 * Prints the licence key (`FLASH1.<payload>.<signature>`) on stdout, and on stderr the public key it
 * verifies against, to compare with the build's VITE_LICENSE_PUBLIC_KEY. The payload is signed, not
 * encrypted: whoever holds the licence key can read the key ID and holder.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
// The app's own encoder (Node strips the types), so script and verifier cannot drift apart.
import { canonicalLicenseMessage, encodeLicenseKey } from '../packages/core/src/license/index.ts';

const USAGE =
  'Usage: node scripts/license-sign.mjs --key <private-key-file> --key-id <id> ' +
  '[--holder <name or email>] [--issued-at <YYYY-MM-DD>]';

/** The error never repeats the argument or the file's content: either could be the key itself. */
function readPrivateKey(file) {
  let privateKey;
  try {
    // Suppressed below: the owner names their own key file, and nothing read from it is printed.
    const pem = readFileSync(file); // NOSONAR (jssecurity:S8707)
    privateKey = createPrivateKey(pem);
  } catch (err) {
    throw new Error(
      `Cannot read a private key from the --key file (${err?.code ?? 'unknown error'}).`,
      { cause: err },
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The --key file is not an Ed25519 private key.');
  }
  return privateKey;
}

/** Epoch milliseconds for a UTC calendar date, or now when none is given. */
function issuedAtMillis(date) {
  if (date === undefined) return Date.now();
  const millis = Date.parse(`${date}T00:00:00Z`);
  // The round trip rejects other formats and dates that roll over (2026-02-30).
  if (Number.isNaN(millis) || new Date(millis).toISOString().slice(0, 10) !== date) {
    throw new Error('--issued-at must be a date written YYYY-MM-DD.');
  }
  return millis;
}

function main() {
  const { values } = parseArgs({
    options: {
      key: { type: 'string' },
      'key-id': { type: 'string' },
      holder: { type: 'string' },
      'issued-at': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const keyId = values['key-id']?.trim();
  const holder = values.holder?.trim();
  if (!values.key || !keyId) throw new Error(`--key and --key-id are required.\n${USAGE}`);
  if (holder === '') throw new Error('--holder must not be blank; leave it out instead.');

  const privateKey = readPrivateKey(values.key);
  const payload = {
    v: 1,
    product: 'flashcards-unlock-v1',
    edition: 'lifetime',
    keyId,
    issuedAt: issuedAtMillis(values['issued-at']),
    ...(holder ? { holder } : {}),
  };
  // The signature covers the encoded payload: encode once unsigned to get it, then again signed.
  const payloadB64Url = encodeLicenseKey(payload, new Uint8Array(64)).split('.')[1];
  const signature = sign(null, canonicalLicenseMessage(payloadB64Url), privateKey);

  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' });
  console.error(`Verifies against: ${Buffer.from(publicKey.x, 'base64url').toString('hex')}`);
  console.log(encodeLicenseKey(payload, signature));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
