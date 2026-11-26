import { describe, expect, it } from 'vitest';
import { isFreshPkce, PKCE_MAX_AGE_MS } from '../src/auth/pkce-expiry.ts';

describe('PKCE record expiry (S13)', () => {
  const made = 1_750_000_000_000;

  it('expires only once the elapsed time passes the limit', () => {
    expect(isFreshPkce(made, made)).toBe(true);
    expect(isFreshPkce(made, made + PKCE_MAX_AGE_MS)).toBe(true);
    expect(isFreshPkce(made, made + PKCE_MAX_AGE_MS + 1)).toBe(false);
  });

  it('accepts a clock that moved backwards after sign-in started', () => {
    expect(isFreshPkce(made, made - 5 * 60_000)).toBe(true);
    expect(isFreshPkce(made, made - 2 * PKCE_MAX_AGE_MS)).toBe(true);
  });

  it('refuses a record without a usable timestamp', () => {
    expect(isFreshPkce(undefined, made)).toBe(false);
    expect(isFreshPkce(Number.NaN, made)).toBe(false);
  });
});
