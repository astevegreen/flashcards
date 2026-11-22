# Follow-ups

Open items left after the Phase 12/13/14 batch (PR #8). Tick an item off, or delete it, once it is resolved. Product decisions belong to the owner. Until one is made, the shipped default is the least-committal, reversible option described here.

## Release blockers (fix before store submission)

- [ ] **Capacitor OneDrive tokens are not in Keychain/Keystore.** No maintained MSAL plugin supports Capacitor 8, so the Microsoft sign-in on Android/iOS uses the generic OAuth2 provider of `@capgo/capacitor-social-login`. That plugin keeps tokens in UserDefaults (iOS) and SharedPreferences (Android). Phase 14's compliance checklist requires tokens only in Keychain/Keystore on native. Move the refresh token into secure storage, or switch to an MSAL-based plugin once one supports Capacitor 8. Code: `packages/platform-capacitor` (`microsoft-social-login.ts`).
- [ ] **Android Microsoft redirect.** The flow uses an in-app view. Using Custom Tabs needs a `flashcards://oauth` intent filter, and `AndroidManifest.xml` was not changed.

## Not verified on real devices or services

Only Chromium Playwright with faked endpoints has covered these.

- [ ] Tauri loopback Microsoft sign-in end to end, including whether `tauri-plugin-http` sends an `Origin` header that Entra rejects (AADSTS9002327).
- [ ] Capacitor Microsoft sign-in on Android and iOS, including whether `SocialLogin.initialize` with the oauth2 config keeps the existing Google provider config on Android.
- [ ] OneDrive download and upload-session URLs allowing CORS from the Capacitor and Tauri WebView origins.
- [ ] Real Microsoft Graph and Entra behaviour, against a real app registration (`docs/setup-microsoft.md`).
- [ ] Tauri attaching its CSP to Worker script responses, so the FSRS optimizer and the Anki SQLite WASM run under `'wasm-unsafe-eval'`.
- [ ] iOS WKWebView module Workers loaded from the `capacitor://` scheme.
- [ ] Real Anki 23.x/24.x `anki21b` exports. The fixture is synthetic, and its schema-18 DDL was written from memory.

## Owner decisions (defaults shipped in PR #8)

### Onboarding (Phase 13/14)

- [ ] **Starter deck per language.** Today it offers the built-in sample decks. Curated starter decks, or the remote starter catalog inside onboarding, are undecided.
- [ ] **Language list.** It comes from the sample decks, in sample order. Ordering or preselecting by device locale is undecided.
- [ ] **Existing users.** Onboarding appears only on an empty collection and only on a device with no onboarding record. Prompting existing users once was not chosen.
- [ ] **Empty-screen buttons.** "Connect Cloud Sync" and "Load Sample Decks" are kept below onboarding. Phase 14 may want them de-emphasised.
- [ ] **Re-offering onboarding after "Reset Local Device Data"** depends on whether that reset clears the kv store.

### Leech backfill

- [ ] **Backfill timing.** It runs once per launch, after that launch's first sync. On a device with a sync provider that never syncs during a launch (for example, offline all session), it waits for the next launch.
- [ ] **A concurrent tag edit can drop the leech tag.** A `NoteUpserted` with a later HLC, from a device that hadn't seen the backfill, drops the automatic leech tag for good. State still converges, and the virtual leech filter still matches those cards.
- [ ] **Older builds.** Builds from before `NoteTagsAdded` keep the event as unknown and don't show the tag. Acceptable before launch; confirm.

### Anki import

- [ ] **Deck mapping.** Each (Anki deck, model) pair becomes one deck, named `Deck (Model)` when an Anki deck holds several models.
- [ ] **How to render the Anki `kana:` filter.** Today it shows as ruby.
- [ ] **Field language detection.** Language is guessed per field (kana means ja, hangul means ko, and so on). A deck-level language prompt may be better.
- [ ] **Media per field.** Only the first image and the first audio reference per field are kept, with a warning.
- [ ] **Card state.** Suspended, buried and flagged states, deck options and Anki's current scheduling state are not imported.
- [ ] **`.colpkg`.** Full collection backups are not offered.
- [ ] **Import caps.** See `ANKI_IMPORT_LIMITS` for the current values.

### OneDrive

- [ ] **Tenant.** The default is `consumers` (personal accounts only). Work and school accounts need `MS_TENANT`/`VITE_MS_TENANT=common`, plus `*.sharepoint.com` hosts.
- [ ] **The picker is a one-shot import.** Linked OneDrive sources that refresh were not built.
- [ ] **Web depends on the token-helper.** There is no fallback to an SPA client with 24-hour refresh tokens.
- [ ] **Hosted File Picker v8.** Not adopted. Adopting it would need its redirect hosts verified under the CSP and pinned.

### Hosting

- [ ] **Cloudflare `_headers` file.** Decide whether to commit one to `apps/web/public`. The required headers are in `docs/setup-gcp-cloudflare.md` §6.

## Skipped Phase 14 work

- [ ] "Sync my devices" default-provider logic: iCloud for Apple-only users, Google otherwise.
- [ ] Add-device QR code or short link.
- [ ] `docs/onboarding-review.md`, the audit with measured tester results on real devices.

## Phase 10 remainder (to audit)

- [ ] Confirm what's left after the first slice in PR #5. Candidates: merging in the other dictionary sources (우리말샘, Wiktionary), Hanja ↔ word links, Add to Deck mapping, the KRDict audio licence check, and the same search treatment for `ja`/`zh-Hans`.
