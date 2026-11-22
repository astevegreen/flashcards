/**
 * Capacitor Android & iOS shell configuration (§10.1, §11, §15 Phase 8).
 * Wraps the static SPA output in `../web/dist` and configures custom URL scheme
 * `flashcards://picker-callback` for native system-browser Google Picker grants.
 */
export interface CapacitorShellConfig {
  appId: string;
  appName: string;
  webDir: string;
  server: {
    androidScheme: 'https';
    iosScheme: 'capacitor';
  };
  plugins: {
    CapacitorSQLite: {
      iosDatabaseLocation: string;
      androidIsEncryption: boolean;
    };
    DeepLinks: {
      customSchemes: string[];
    };
  };
}

const config: CapacitorShellConfig = {
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
      androidIsEncryption: false,
    },
    DeepLinks: {
      customSchemes: ['flashcards://picker-callback'],
    },
  },
};

export default config;
