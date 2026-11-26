/**
 * One loopback OAuth round trip for the Tauri desktop shell (RFC 8252), shared by the Google,
 * Dropbox and Microsoft sign-ins (R3): make a PKCE pair and `state`, start the one-shot loopback
 * server, open the system browser, wait for the redirect, check it, then redeem the code. The
 * server is always released, so a fixed port (Dropbox) is free for the next attempt.
 */
import {
  cancel as cancelOAuthServer,
  onUrl,
  start as startOAuthServer,
} from '@fabianlars/tauri-plugin-oauth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPkcePair, randomBase64Url } from '@flash/platform-web/pkce';
import { awaitBrowserCallback, OAUTH_CALLBACK_TIMEOUT_MS } from './browser-callback.ts';

export interface LoopbackSignInOptions {
  /** Names the provider in errors ("Dropbox" → "Dropbox sign-in failed: …"). */
  provider: string;
  /** Names the wait in timeout errors ("OneDrive sign-in"); default `<provider> sign-in`. */
  label?: string;
  /** Page the loopback server shows after the redirect. */
  successHtml: string;
  /** Fixed ports to try (providers that need exact redirect URIs); default any free port. */
  ports?: readonly number[];
  /** Redirect host; `localhost` for Entra, which ignores the port of a localhost redirect. */
  redirectHost?: '127.0.0.1' | 'localhost';
  signal?: AbortSignal;
  /** The authorize URL for this attempt. */
  buildAuthUrl: (params: { redirectUri: string; challenge: string; state: string }) => string;
}

/** Reads `code` from the loopback callback URL after checking `state` and `error`. */
export function codeFromCallback(
  callbackUrl: string,
  expectedState: string,
  provider: string,
): string {
  const returned = new URL(callbackUrl);
  if (returned.searchParams.get('state') !== expectedState) {
    throw new Error('OAuth state mismatch.');
  }
  const err = returned.searchParams.get('error');
  if (err) throw new Error(`${provider} sign-in failed: ${err}`);
  const code = returned.searchParams.get('code');
  if (!code) throw new Error(`${provider} sign-in returned no authorization code.`);
  return code;
}

export async function runLoopbackSignIn<T>(
  options: LoopbackSignInOptions,
  redeem: (params: { code: string; verifier: string; redirectUri: string }) => Promise<T>,
): Promise<T> {
  const { verifier, challenge } = await createPkcePair();
  const state = randomBase64Url(16);
  const port = await startOAuthServer({
    ...(options.ports ? { ports: [...options.ports] } : {}),
    response: options.successHtml,
  });
  const redirectUri = `http://${options.redirectHost ?? '127.0.0.1'}:${port}`;
  try {
    const authUrl = options.buildAuthUrl({ redirectUri, challenge, state });
    const callbackUrl = await awaitBrowserCallback({
      subscribe: (cb) => onUrl(cb),
      open: () => openUrl(authUrl),
      timeoutMs: OAUTH_CALLBACK_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      label: options.label ?? `${options.provider} sign-in`,
    });
    const code = codeFromCallback(callbackUrl, state, options.provider);
    return await redeem({ code, verifier, redirectUri });
  } finally {
    await cancelOAuthServer(port).catch(() => undefined);
  }
}
