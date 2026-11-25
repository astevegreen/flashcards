/**
 * Native Google sign-in on top of `@capgo/capacitor-social-login` (Android Credential Manager, iOS
 * GoogleSignIn), reduced to an injectable port so it can be unit-tested. `native/plugins.ts` wires
 * the real plugin.
 */
import type { NativeGoogleSignInPlugin } from './native-google-auth.ts';

/** The subset of the plugin's Google login response this adapter reads. */
export interface GoogleSocialLoginResult {
  responseType: string;
  accessToken?: { token: string; expires?: string } | null;
  profile?: { email?: string | null };
}

/** The sign-in plugin, reduced to what this adapter needs. */
export interface GoogleSocialLoginPort {
  /** `silent` signs in again with an already authorized account and no account chooser. */
  login(options: { scopes: string[]; silent: boolean }): Promise<GoogleSocialLoginResult>;
  logout(): Promise<void>;
}

export interface GoogleSignInOptions {
  /**
   * Runs after every successful sign-in, silent or not. Android uses it to delete the ID and access
   * tokens the plugin saves in plaintext SharedPreferences (§16: tokens only in Keychain/Keystore).
   * A failure is logged and never fails the sign-in; the next launch deletes the copy again.
   */
  afterLogin?: () => Promise<void>;
  nowMs?: () => number;
}

/**
 * Runs in `online` mode (access token returned directly, no Worker). Google issues no refresh token
 * to native clients in this mode, so "refresh" re-runs a silent sign-in for the authorized account.
 */
export function createGoogleSignIn(
  port: GoogleSocialLoginPort,
  options: GoogleSignInOptions = {},
): NativeGoogleSignInPlugin {
  const nowMs = options.nowMs ?? (() => Date.now());
  let lastScopes: string[] = [];

  const runAfterLogin = async () => {
    if (!options.afterLogin) return;
    try {
      await options.afterLogin();
    } catch (err) {
      console.warn('Could not clear the Google sign-in plugin’s token copy:', err);
    }
  };

  const login = async (scopes: string[], silent: boolean) => {
    const result = await port.login({ scopes, silent });
    await runAfterLogin();
    const token = result.responseType === 'online' ? result.accessToken?.token : undefined;
    if (!token) throw new Error('Google Sign-In did not return an access token.');
    const expiresAt = result.accessToken?.expires
      ? Date.parse(result.accessToken.expires)
      : Number.NaN;
    const expiresInSeconds = Number.isFinite(expiresAt)
      ? Math.max(60, Math.round((expiresAt - nowMs()) / 1000))
      : 3500;
    const email = result.profile?.email;
    return {
      accessToken: token,
      expiresInSeconds,
      scope: scopes.join(' '),
      ...(email ? { email } : {}),
    };
  };

  return {
    signIn: async ({ scopes }) => {
      lastScopes = scopes;
      return login(scopes, false);
    },
    // `lastScopes` is empty after a relaunch, so the caller's scopes win when it passes any (N4).
    refreshToken: async (opts) => {
      if (opts?.scopes && opts.scopes.length > 0) lastScopes = opts.scopes;
      return login(lastScopes, true);
    },
    signOut: () => port.logout(),
  };
}
