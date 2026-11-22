# Onboarding & Setup Review (Phase 14)

Phase 14 is the store-launch gate: the app doesn't go to the stores until this review passes
(`docs/design_blueprint.md`, "Phase 14"). This document holds the audit. It has two parts:

1. **Developer-measured baseline** (filled in below). Automated Playwright runs on a developer
   machine. It is a regression guard for the code, **not tester results**.
2. **Real-device audit with non-technical testers** (to do). This is the audit Phase 14 asks for.
   Nothing in part 1 replaces it.

## Status

- [x] Developer-measured baseline for "new user: first card on screen" (2026-11-22).
- [ ] Real-device audit with non-technical testers (all flows below).
- [ ] Fixes from the audit.
- [ ] Sign-off.

## 1. Developer-measured baseline (not tester results)

> **Not tester results.** These figures come from Chromium driven by Playwright on the developer's
> Windows PC, against the production preview build (`pnpm build`, then `vite preview` on
> `127.0.0.1`). The tests know where every button is and tap instantly, and no install, app store,
> network latency or first-run OS prompt is involved. They show that the code path meets the
> targets. They say nothing about how long a real person takes. They are **not** a substitute
> for the real-device audit in part 2.

Measured 2026-11-22 by `tests/e2e/phase14-first-card.spec.ts` (Chromium Playwright, Windows 11,
fresh browser context with empty storage, production preview build):

| Run                              | Taps | Time from `page.goto` to first card visible | Sign-ins |
| -------------------------------- | ---- | ------------------------------------------- | -------- |
| Desktop viewport 1280×720, mouse | 2    | 0.40 s                                      | 0        |
| Phone viewport 390×844, touch    | 2    | 0.48 s                                      | 0        |

The taps were "Korean" (first in the language list) and the first starter deck. The test fails if
the flow needs more than 3 taps or takes 30 s or more, so it guards the targets from now on. Times
vary between runs and machines; treat them as an order of magnitude.

What the baseline covers, as automated checks (all in `tests/e2e/`):

- `phase14-first-card.spec.ts`: first launch to the first card (taps and time), Korean first in the
  language list, English then Korean on a Korean-locale device, and Reset Local Device Data
  offering onboarding again.
- `phase13-onboarding.spec.ts`: onboarding steps, skip, the empty screen's "Bring my cards" and
  "I already use this app: sync my devices" buttons, and the one-time "Sync my devices" prompt
  after the first finished session (it never moves the study controls).
- `phase14-add-device-sync.spec.ts`: "Sync my devices" defaults, the add-device QR code and link
  (provider and collection only), a second device joining through the link (OneDrive faked end to
  end) and being told whether it reached the same collection, malformed links being ignored, and
  the prompt for collections that did not come through onboarding.

Not measured here: "second device fully synced ≤ 2 min with exactly one sign-in". The automated
OneDrive run uses an instant fake sign-in, so its timing means nothing for real people.

## 2. Real-device audit (to do)

Phase 14 asks for every first-run path to be walked on real devices, measured with non-technical
testers rather than developers.

### Devices

| Device                    | OS version | App build | Tester | Date |
| ------------------------- | ---------- | --------- | ------ | ---- |
| Android phone (fresh)     |            |           |        |      |
| iPhone (fresh)            |            |           |        |      |
| Windows PC                |            |           |        |      |
| Tablet                    |            |           |        |      |
| Foldable (cover + inside) |            |           |        |      |

### Targets

| Target                                                          | Measured | Pass? |
| --------------------------------------------------------------- | -------- | ----- |
| First card on screen ≤ 30 s after install                       |          |       |
| First card on screen in ≤ 3 taps after install, with no sign-in |          |       |
| Second device fully synced ≤ 2 min                              |          |       |
| Second device needs exactly one sign-in                         |          |       |
| Zero terminal commands                                          |          |       |
| Zero hand-copied keys or tokens                                 |          |       |
| Zero app-specific passwords                                     |          |       |

### Flows

For each flow, log every screen, tap, permission prompt, sign-in, consent screen, app switch and
piece of typed text. Each one has to justify itself; otherwise it is removed, deferred or
automated. Copy the step table once per device.

#### New user

| #   | Screen | Action (tap / type / prompt / sign-in / consent / app switch) | Needed? Why | Fix |
| --- | ------ | ------------------------------------------------------------- | ----------- | --- |
| 1   |        |                                                               |             |     |

Time to first card: \_\_\_ s. Taps: \_\_\_.

#### Second device

Start from a device that already syncs: Settings, Cloud Sync, **Add a device**, then scan the QR
code (or open the link) on the new device.

| #   | Screen | Action | Needed? Why | Fix |
| --- | ------ | ------ | ----------- | --- |
| 1   |        |        |             |     |

Time to fully synced: \_\_\_ s. Sign-ins: \_\_\_.

#### Import from Flashcards Deluxe or Anki ("Bring my cards")

| #   | Screen | Action | Needed? Why | Fix |
| --- | ------ | ------ | ----------- | --- |
| 1   |        |        |             |     |

#### Restore from backup

| #   | Screen | Action | Needed? Why | Fix |
| --- | ------ | ------ | ----------- | --- |
| 1   |        |        |             |     |

#### Restore purchase

| #   | Screen | Action | Needed? Why | Fix |
| --- | ------ | ------ | ----------- | --- |
| 1   |        |        |             |     |

### Known gaps to check during the audit

- **macOS has no iCloud transport.** iCloud Drive sync exists only in the iOS app, so "Sync my
  devices" defaults to Google Drive on the macOS desktop app.
- **The add-device link opens the web app.** In the native apps (Android, iOS, desktop) there is no
  app link for it yet, so they show which provider to pick instead of a QR code.
- **Sign-in screens are the provider's.** Count Google, Microsoft and Dropbox consent screens as
  steps; they can't be removed, only explained.

## 3. Fixes made

| Date       | Finding                                                  | Fix                                                                                         |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 2026-11-22 | Sync set-up meant picking from a row of providers        | One "Sync my devices" button: iCloud where available, otherwise Google Drive; others listed |
| 2026-11-22 | A second device had to know which provider to choose     | Add-device QR code and short link (provider + collection only, never tokens)                |
| 2026-11-22 | The language list followed sample-deck order             | Korean first; English, then Korean, on a Korean-locale device; nothing preselected          |
| 2026-11-22 | Collections from before onboarding never got the prompt  | The one-time "Sync my devices" prompt covers every device with cards and no sync            |
| 2026-11-22 | Reset Local Device Data didn't re-offer onboarding       | Reset clears the onboarding record, like a fresh install                                    |
| 2026-11-22 | The empty screen offered sample decks next to onboarding | Removed; "Bring my cards" and "I already use this app: sync my devices" remain              |

## 4. Sign-off checklist

- [ ] Every flow above walked on every device in the table, by non-technical testers.
- [ ] Every target in the targets table measured and met (or a fix logged and re-measured).
- [ ] Every step in every flow justified, or removed, deferred or automated.
- [ ] Sign-in always goes through the system account picker or the provider's own page; the app
      never sees a password.
- [ ] Permissions are asked just in time (notifications only when reminders are turned on, folder
      access only when a folder is linked).
- [ ] Power-user tools (CLI, MCP server) appear nowhere in user onboarding.
- [ ] Compliance checklist in the blueprint re-verified against current store policy.
- [ ] Signed off by: \_\_\_\_\_\_\_\_ Date: \_\_\_\_\_\_\_\_
