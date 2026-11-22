# Follow-ups

Open items left after the Phase 12/13/14 batch (PR #8). Tick an item off, or delete it, once it is resolved. Product decisions belong to the owner. Until one is made, the shipped default is the least-committal, reversible option described here.

## Next batch (decided 2026-11-22): Phase 14 code + the release blocker

- [ ] **Secure-store bridge for phone tokens (release blocker).** Add a small Keychain (iOS) / Keystore (Android) storage plugin and keep the Microsoft refresh token only there. `@capgo/capacitor-social-login` stays for the sign-in itself. Today it keeps tokens in UserDefaults/SharedPreferences, which Phase 14's compliance checklist forbids. Code: `packages/platform-capacitor` (`microsoft-social-login.ts`).
- [ ] **Android Microsoft redirect.** The flow uses an in-app view. Using Custom Tabs needs a `flashcards://oauth` intent filter, and `AndroidManifest.xml` was not changed.
- [ ] **"Sync my devices" default.** iOS/macOS devices default to iCloud (no sign-in). Android, Windows and web default to Google Drive. The other providers are always listed as alternatives.
- [ ] **Add-device QR code or short link.** It carries the provider and collection, never tokens.
- [ ] **Guided "Bring my cards" import.** Detects Flashcards Deluxe CSV, Anki `.apkg`, `.flashpkg` and Google Sheets.
- [ ] **Curated starter decks** per language for onboarding (e.g. TOPIK 1 vocabulary, JLPT N5, HSK 1). They must be small, properly attributed and shipped in the app, replacing the sample decks in onboarding. Open questions for that batch: the source list and licence per deck, and deck size.
- [ ] **Commit a Cloudflare Pages `_headers` file** to `apps/web/public`, with the CSP and `.wasm` headers from `docs/setup-gcp-cloudflare.md` §6, plus a test that keeps it in sync with `apps/web/csp.ts`.
- [ ] **Anki `kana:` fields render readings only.** `漢字[かんじ]` becomes `かんじ`, matching Anki. Today they show as ruby.
- [ ] **Anki field languages.** Keep automatic detection, but show the detected language per field in the import summary with a way to change it.
- [ ] **Onboarding language order** (approved 2026-11-22). Don't preselect from the device locale, because the locale shows what people speak, not what they're learning. Put Korean first. On a Korean-locale device, put English first.
- [ ] **Existing users never see onboarding** (approved 2026-11-22). It stays on empty collections only. Users with data but no sync provider get the existing one-time "Sync my devices" prompt instead.
- [ ] **Empty-screen buttons** (approved 2026-11-22). Keep the sync button visible, renamed along the lines of "I already use this app: sync my devices" and tied to the add-device QR code. Drop "Load Sample Decks", which onboarding replaces.
- [ ] **Re-offer onboarding after "Reset Local Device Data"** (approved 2026-11-22). Clear the `onboarding_v1` record on reset, so a reset behaves like a fresh install.
- [ ] `docs/onboarding-review.md`, the audit with measured tester results on real devices. This needs real devices and non-technical testers, so it may not fit in a code batch.

## Not verified on real devices or services

Only Chromium Playwright with faked endpoints has covered these.

- [ ] Tauri loopback Microsoft sign-in end to end, including whether `tauri-plugin-http` sends an `Origin` header that Entra rejects (AADSTS9002327).
- [ ] Capacitor Microsoft sign-in on Android and iOS, including whether `SocialLogin.initialize` with the oauth2 config keeps the existing Google provider config on Android.
- [ ] OneDrive download and upload-session URLs allowing CORS from the Capacitor and Tauri WebView origins.
- [ ] Real Microsoft Graph and Entra behaviour, against a real app registration (`docs/setup-microsoft.md`).
- [ ] Tauri attaching its CSP to Worker script responses, so the FSRS optimizer and the Anki SQLite WASM run under `'wasm-unsafe-eval'`.
- [ ] iOS WKWebView module Workers loaded from the `capacitor://` scheme.
- [ ] Real Anki 23.x/24.x `anki21b` exports. The fixture is synthetic, and its schema-18 DDL was written from memory.

## Decided, no change needed (2026-11-22)

- **OneDrive accounts:** personal only (tenant `consumers`).
- **Leech tag lost to a concurrent edit from another device:** accepted. It is rare, state converges, and the leech filter still finds those cards by lapse count.
- **Leech backfill timing:** once per launch, after that launch's first sync. An offline launch waits for the next one.
- **Anki deck mapping:** one deck per (Anki deck, model) pair, because a deck has a single note type here.

## Still open

### Anki extras (owner: no preference; proposed defaults)

- [ ] **Suspended state:** import it (`CardSuspended` events). Proposed: yes, cheap and expected.
- [ ] **All media per field:** keep every image and audio reference, not just the first. Proposed: yes.
- [ ] **Current scheduling:** seed FSRS from Anki's due/interval/ease when review history isn't imported. Proposed: no for now, because the mapping from SM-2 state is lossy.
- [ ] **`.colpkg` full backups.** Proposed: later.
- [ ] **Older builds and `NoteTagsAdded`.** Builds from before `NoteTagsAdded` keep the event as unknown and don't show the tag. Acceptable before launch.

### OneDrive later

- [ ] **Linked OneDrive sources** that refresh like Google Sheets sources (owner: yes, later). Today the picker is a one-shot import.
- Not planned: a web fallback without the token-helper, and Microsoft's hosted File Picker v8.

## Phase 10 remainder (to audit)

- [ ] Confirm what's left after the first slice in PR #5. Candidates: merging in the other dictionary sources (우리말샘, Wiktionary), Hanja ↔ word links, Add to Deck mapping, the KRDict audio licence check, and the same search treatment for `ja`/`zh-Hans`.
