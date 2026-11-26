/**
 * How long a pending OAuth PKCE record (verifier + state) stays usable (S13). The providers' own
 * authorization codes last about 10 minutes; 30 leaves room for a slow consent screen, and an
 * older record is dropped instead of being kept in storage for good.
 */
export const PKCE_MAX_AGE_MS = 30 * 60_000;

/** True when a PKCE record made at `createdAt` is still usable at `nowMs`. */
export function isFreshPkce(createdAt: number | undefined, nowMs: number): boolean {
  return (
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    nowMs - createdAt >= 0 &&
    nowMs - createdAt <= PKCE_MAX_AGE_MS
  );
}
