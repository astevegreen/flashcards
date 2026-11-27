import { describe, expect, it } from 'vitest';
import { DropboxAppFolderTransport } from '../src/sync/dropbox-transport.ts';
import { GoogleDriveAppDataTransport } from '../src/sync/google-drive-transport.ts';
import { OneDriveAppFolderTransport } from '../src/sync/onedrive-transport.ts';
import { FakeDriveServer } from './fakes/fake-drive.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';
import { FakeGraphServer } from './fakes/fake-graph.ts';
import { faultyFetch, tokenIssuer } from './helpers/faulty-fetch.ts';
import {
  describeSyncTransportContract,
  type SyncTransportHarness,
} from './helpers/sync-transport-contract.ts';

/**
 * §9: every HTTP `SyncTransport` runs the same contract, including the 401 refresh and the 429
 * retry, against its provider's fake. Each harness rotates its token on a forced refresh, and the
 * fake rejects an expired token, so the 401 test proves the retry used a new token. (In-memory
 * and local-folder transports run the storage-only part of the contract in their own test files.)
 */

const noSleep = async () => {};

function googleDrive(): SyncTransportHarness {
  const tokens = tokenIssuer('google');
  const faults = faultyFetch(new FakeDriveServer().fetch, tokens);
  const transport = new GoogleDriveAppDataTransport({
    auth: {
      isConfigured: () => true,
      isConnected: async () => true,
      getSession: async () => null,
      getValidAccessToken: tokens.getToken,
      signIn: async () => null,
      handleRedirectCallback: async () => null,
      signOut: async () => {},
    },
    fetchImpl: faults.fetch,
    sleep: noSleep,
    random: () => 0,
  });
  return { transport, faults, tokens, throttlesWith403: true };
}

function dropbox(): SyncTransportHarness {
  const tokens = tokenIssuer('dbx');
  const faults = faultyFetch(new FakeDropboxServer().fetch, tokens);
  const transport = new DropboxAppFolderTransport({
    getAccessToken: tokens.getToken,
    fetchImpl: faults.fetch,
    sleep: noSleep,
    random: () => 0,
  });
  return { transport, faults, tokens };
}

function oneDrive(): SyncTransportHarness {
  const tokens = tokenIssuer('graph-token');
  const server = new FakeGraphServer();
  const faults = faultyFetch(server.fetch, tokens);
  const transport = new OneDriveAppFolderTransport({
    auth: {
      // The Graph fake checks its own token list too: register each token as it is issued.
      getValidAccessToken: async (opts) => {
        const token = await tokens.getToken(opts);
        server.validTokens.add(token);
        return token;
      },
    },
    fetchImpl: faults.fetch,
    sleep: noSleep,
    random: () => 0,
  });
  return { transport, faults, tokens };
}

describeSyncTransportContract('GoogleDriveAppDataTransport (fake Drive)', googleDrive);
describeSyncTransportContract('DropboxAppFolderTransport (fake Dropbox, faults)', dropbox);
describeSyncTransportContract('OneDriveAppFolderTransport (fake Graph, faults)', oneDrive);

describe('conformance harness', () => {
  it('passes requests through once the injected faults are used up', async () => {
    const { transport, faults } = dropbox();
    faults?.failNext(503, 1);
    await transport.write('sync/v1/manifest.json', new Uint8Array([1]));
    expect(await transport.read('sync/v1/manifest.json')).toEqual(new Uint8Array([1]));
  });

  it('rejects an expired token and accepts only the refreshed one', async () => {
    const tokens = tokenIssuer('t');
    expect(tokens.accepts(`Bearer ${await tokens.getToken()}`)).toBe(true);
    tokens.expireAll();
    expect(tokens.accepts('Bearer t-1')).toBe(false);
    const fresh = await tokens.getToken({ forceRefresh: true });
    expect(fresh).toBe('t-2');
    expect(tokens.accepts(`Bearer ${fresh}`)).toBe(true);
    expect(tokens.accepts('Bearer other-2')).toBe(false);
    expect(tokens.accepts('Bearer t-3')).toBe(false);
  });

  it('lets a request with no Authorization header through', async () => {
    const tokens = tokenIssuer('t');
    tokens.expireAll();
    const { fetch } = faultyFetch(async () => new Response('ok'), tokens);
    expect((await fetch('https://upload.example/session')).status).toBe(200);
    expect(
      (await fetch('https://api.example/', { headers: { Authorization: 'Bearer t-1' } })).status,
    ).toBe(401);
  });
});
