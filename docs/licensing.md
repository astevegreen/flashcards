# Licence keys: generating, issuing, rotating

For web and desktop direct sales (design blueprint §12.1). A licence key is a payload signed with an
Ed25519 **private key** that only the owner holds. The app checks it offline against the matching
**public key**, which is built into the bundle. The scripts need Node (the version in
`package.json`) and nothing else.

## 1. Generate the key pair (once)

Pick a folder outside every git checkout (an offline drive, or a temporary folder if the key goes
straight into a password manager). The folder must exist.

```powershell
node scripts/license-keygen.mjs --out E:\keys\flash-license-private-key.pem
```

It prints `VITE_LICENSE_PUBLIC_KEY=` followed by 64 hex characters, and writes the private key to
the file. It refuses to overwrite a file or to write inside a git working tree, and it never
prints the private key. The file is limited to your user account (mode `0600`; on Windows, a single
access entry). Drives without permissions, such as FAT32 or exFAT, cannot do that, and the script
warns you.

## 2. Keep the private key safe

- Keep it in a password manager (as a secure attachment or note) or on an offline backup, ideally
  both, then delete other copies. The file is **not** passphrase-protected, and copying it elsewhere
  does not carry its permissions along.
- Never put it in the repository, a CI log or CI secret, a `.env` file, chat or email. No build
  needs it. `.gitignore` covers file names containing `license-private-key` as a last resort only.
- If it is lost, you cannot issue more keys for the builds that are out. If it leaks, anyone can
  issue keys. Either way, rotate (section 5).

## 3. Put the public key in a build

The public key is not secret. Two build-time settings matter:

| Setting                    | Value for a commercial web or desktop build                               |
| -------------------------- | ------------------------------------------------------------------------- |
| `VITE_ENABLE_LICENSE_GATE` | `true`. Otherwise it is a personal build: everything is already unlocked. |
| `VITE_LICENSE_PUBLIC_KEY`  | The 64 hex characters. Unset or malformed: every licence key is refused.  |

Set them in the build's environment, or locally in `apps/web/.env.production.local` (gitignored;
Vite reads env files from `apps/web/`, not from the repository root):

```powershell
$env:VITE_ENABLE_LICENSE_GATE = 'true'
```

```powershell
$env:VITE_LICENSE_PUBLIC_KEY = '<64 hex characters>'
```

```powershell
pnpm --filter @flash/web build
```

The desktop build (`pnpm --filter @flash/desktop build`) runs that web build itself and inherits the
same environment.

**CI:** no workflow in this repository builds a release today, so there is nothing to set yet. When
one does (or in a hosting provider's build settings), store the public key as a repository variable
(Settings → Secrets and variables → Actions) and pass it to the build step. A secret works too: use
`secrets.` in place of `vars.`.

```yaml
- name: Build the web app
  run: pnpm --filter @flash/web build
  env:
    VITE_ENABLE_LICENSE_GATE: 'true'
    VITE_LICENSE_PUBLIC_KEY: ${{ vars.VITE_LICENSE_PUBLIC_KEY }}
```

### Store builds: licence keys stay off

Leave `VITE_STORE_LICENSE_KEYS` unset in every Android and iOS build. Store builds unlock through
in-app purchase only, because App Store guideline 3.1.1 restricts key unlocks. The setting covers the
Capacitor shells only (a sideloaded APK included). **A Tauri desktop build accepts licence keys
whenever it has a public key**, so do not submit one to the Mac App Store or Microsoft Store with
the key set until that store's purchase rules have been checked.

## 4. Issue a licence key

```powershell
node scripts/license-sign.mjs --key E:\keys\flash-license-private-key.pem --key-id lic-2026-0001 --holder "buyer@example.com"
```

| Option        | Payload field | Meaning                                                    |
| ------------- | ------------- | ---------------------------------------------------------- |
| `--key-id`    | `keyId`       | Required. Your own unique reference for this sale.         |
| `--holder`    | `holder`      | Optional name or email, shown in the app after activation. |
| `--issued-at` | `issuedAt`    | Optional `YYYY-MM-DD` (UTC midnight). Defaults to now.     |

The other signed fields are fixed (`v: 1`, `product: flashcards-unlock-v1`, `edition: lifetime`).

The licence key (`FLASH1.<payload>.<signature>`) is the only line on stdout; give it to the buyer,
who pastes it into Settings. The `Verifies against:` line shows the public key that accepts it: check
it matches the one in your build. The payload is signed, **not encrypted**, so anyone who has the key
can read the key ID and holder. Keep your own private list of issued key IDs and buyers.

## 5. Rotating the key

A build holds exactly one public key, and there is no revocation list. Replacing it (generate a new
pair under a new file name, then rebuild with the new public key) means:

- Every key signed with the old private key **stops working** in builds with the new public key,
  including already activated ones: the app re-checks the stored key, so the buyer drops to the free
  tier (2 local decks, no cloud sync) until they enter a new key. Their decks and history stay.
- Re-issue a key to every existing buyer with the new private key (same `--key-id` and `--holder` if
  you like).
- Builds that have not updated keep accepting old keys and refuse new ones. The web app updates
  itself; installed desktop builds do not.
- A single key cannot be cancelled. Rotating is the only way, and it affects all of them.
