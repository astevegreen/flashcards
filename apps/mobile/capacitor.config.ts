import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor Android & iOS shell configuration (§10.1, §11, §15 Phase 8).
 * Wraps the identical static SPA output in `../web/dist`; `apps/web` detects the native
 * runtime and lazily boots `@flash/platform-capacitor/native`.
 *
 * The `flashcards://picker-callback` and `flashcards://oauth/microsoft` deep links are registered
 * natively: Android — intent-filters in `android/app/src/main/AndroidManifest.xml`;
 * iOS — the `flashcards` scheme in `CFBundleURLTypes` in `ios/App/App/Info.plist`
 * (see docs/native-shells.md).
 */
const config: CapacitorConfig = {
  appId: 'app.flashcards.localfirst',
  appName: 'Flashcards',
  webDir: '../web/dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  plugins: {
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
    SocialLogin: {
      google: true,
      apple: false,
      facebook: false,
      twitter: false,
    },
  },
};

export default config;
