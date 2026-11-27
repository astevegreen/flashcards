/**
 * Wraps a fake server's `fetch` so the contract suite can make the next requests fail with a
 * chosen status, whatever the provider. `403-rate` is Google's throttling reply (C22). With a
 * {@link TokenIssuer}, the wrapper also checks the bearer token like a real provider: a token the
 * issuer has expired gets a 401, so a request that then succeeds proves the client force-refreshed.
 */
export type InjectedFault = 401 | 429 | 503 | '403-rate';

export interface FaultyFetch {
  fetch: typeof fetch;
  failNext(fault: InjectedFault, times: number): void;
}

/** Hands out `<prefix>-<n>` tokens, a new one after each forced refresh, like a real auth. */
export interface TokenIssuer {
  getToken(opts?: { forceRefresh?: boolean }): Promise<string>;
  /** The provider stops accepting every token issued so far (expiry, revocation). */
  expireAll(): void;
  /** Whether the provider would accept this `Authorization` header. */
  accepts(authorization: string): boolean;
  /** How many tokens were handed out after a forced refresh. */
  readonly forcedRefreshes: number;
}

export function tokenIssuer(prefix: string): TokenIssuer {
  let current = 1;
  let oldestValid = 1;
  let forced = 0;
  return {
    getToken: async (opts) => {
      if (opts?.forceRefresh) {
        current += 1;
        forced += 1;
      }
      return `${prefix}-${current}`;
    },
    expireAll() {
      oldestValid = current + 1;
    },
    accepts(authorization) {
      const match = /^Bearer (.+)-(\d+)$/.exec(authorization);
      if (match?.[1] !== prefix) return false;
      const n = Number(match[2]);
      return n >= oldestValid && n <= current;
    },
    get forcedRefreshes() {
      return forced;
    },
  };
}

function faultResponse(fault: InjectedFault): Response {
  const body =
    fault === '403-rate'
      ? { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }], message: 'Rate' } }
      : { error: { code: fault, message: 'Injected fault' }, error_summary: 'injected/' };
  return new Response(JSON.stringify(body), {
    status: fault === '403-rate' ? 403 : fault,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorizationOf(input: RequestInfo | URL, init: RequestInit | undefined): string | null {
  const fromInit = new Headers(init?.headers).get('Authorization');
  if (fromInit !== null) return fromInit;
  return input instanceof Request ? input.headers.get('Authorization') : null;
}

/**
 * `tokens`: reject a request whose bearer token the issuer no longer accepts. A request with no
 * `Authorization` header (a pre-authenticated download or upload URL) passes.
 */
export function faultyFetch(inner: typeof fetch, tokens?: TokenIssuer): FaultyFetch {
  const queue: InjectedFault[] = [];
  return {
    fetch: (input, init) => {
      const fault = queue.shift();
      if (fault !== undefined) return Promise.resolve(faultResponse(fault));
      const authorization = tokens ? authorizationOf(input, init) : null;
      if (authorization !== null && tokens?.accepts(authorization) === false) {
        return Promise.resolve(faultResponse(401));
      }
      return inner(input, init);
    },
    failNext(fault, times) {
      for (let i = 0; i < times; i++) queue.push(fault);
    },
  };
}
