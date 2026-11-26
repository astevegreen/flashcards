/**
 * Wraps a fake server's `fetch` so the contract suite can make the next requests fail with a
 * chosen status, whatever the provider. `403-rate` is Google's throttling reply (C22).
 */
export type InjectedFault = 401 | 429 | 503 | '403-rate';

export interface FaultyFetch {
  fetch: typeof fetch;
  failNext(fault: InjectedFault, times: number): void;
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

export function faultyFetch(inner: typeof fetch): FaultyFetch {
  const queue: InjectedFault[] = [];
  return {
    fetch: (input, init) => {
      const fault = queue.shift();
      return fault === undefined ? inner(input, init) : Promise.resolve(faultResponse(fault));
    },
    failNext(fault, times) {
      for (let i = 0; i < times; i++) queue.push(fault);
    },
  };
}
