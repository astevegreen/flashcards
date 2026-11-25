/**
 * Drive (and some other Google APIs) report throttling as HTTP 403 with a rate-limit reason in the
 * JSON error body, not as 429. Those must retry and surface as RATE_LIMITED, not as a permission
 * problem that tells the user to reconnect (C22).
 */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
]);

interface GoogleErrorBody {
  error?: {
    status?: unknown;
    errors?: readonly { reason?: unknown }[];
    details?: readonly { reason?: unknown }[];
  };
}

/** True when `res` is Google's 429, or a 403 whose error body names a rate limit. */
export async function isGoogleRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  let body: GoogleErrorBody;
  try {
    body = (await res.clone().json()) as GoogleErrorBody;
  } catch {
    return false;
  }
  const error = body?.error;
  if (!error) return false;
  if (error.status === 'RESOURCE_EXHAUSTED') return true;
  const reasons = [...(error.errors ?? []), ...(error.details ?? [])].map((e) => e?.reason);
  return reasons.some((reason) => typeof reason === 'string' && RATE_LIMIT_REASONS.has(reason));
}
