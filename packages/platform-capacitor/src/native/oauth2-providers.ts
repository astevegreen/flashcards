/**
 * One place that initializes the generic OAuth2 providers of `@capgo/capacitor-social-login`
 * (OneDrive and Dropbox).
 *
 * On Android every `SocialLogin.initialize({ oauth2 })` builds a new OAuth2 provider that holds only
 * the configs in that call. So initializing Dropbox after OneDrive dropped OneDrive's config, and
 * the other way round, and the next sign-in or token read for the dropped one failed (N5). Each
 * registration here re-initializes with every provider registered so far, one call at a time.
 * Registering the same config again is a no-op, so it can't disturb a sign-in in progress.
 */
import { SocialLogin, type OAuth2ProviderConfig } from '@capgo/capacitor-social-login';

export type OAuth2Initialize = (options: {
  oauth2: Record<string, OAuth2ProviderConfig>;
}) => Promise<void>;

export type RegisterOAuth2Provider = (
  providerId: string,
  config: OAuth2ProviderConfig,
) => Promise<void>;

export function createOAuth2ProviderRegistry(initialize: OAuth2Initialize): RegisterOAuth2Provider {
  const configs: Record<string, OAuth2ProviderConfig> = {};
  const registered = new Map<string, { key: string; done: Promise<void> }>();
  let last: Promise<void> = Promise.resolve();

  return (providerId, config) => {
    const key = JSON.stringify(config);
    const existing = registered.get(providerId);
    if (existing?.key === key) return existing.done;

    configs[providerId] = config;
    const all = { ...configs };
    const done = last.catch(() => undefined).then(() => initialize({ oauth2: all }));
    last = done;
    // This call carries every provider, so each one's latest state is this call's outcome.
    const entries = Object.entries(all).map(([id, c]) => {
      const entry = { key: id === providerId ? key : JSON.stringify(c), done };
      registered.set(id, entry);
      return [id, entry] as const;
    });
    // A failed initialize is retried by the next registration of a provider it carried.
    done.catch(() => {
      for (const [id, entry] of entries) {
        if (registered.get(id) === entry) registered.delete(id);
      }
    });
    return done;
  };
}

export const registerOAuth2Provider = createOAuth2ProviderRegistry((options) =>
  SocialLogin.initialize(options),
);
