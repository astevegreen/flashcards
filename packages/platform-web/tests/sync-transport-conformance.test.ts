import { describe, expect, it } from 'vitest';
import { DropboxAppFolderTransport } from '../src/sync/dropbox-transport.ts';
import { GoogleDriveAppDataTransport } from '../src/sync/google-drive-transport.ts';
import { OneDriveAppFolderTransport } from '../src/sync/onedrive-transport.ts';
import { FakeDriveServer } from './fakes/fake-drive.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';
import { FakeGraphServer } from './fakes/fake-graph.ts';
import { faultyFetch } from './helpers/faulty-fetch.ts';
import {
  describeSyncTransportContract,
  type SyncTransportHarness,
} from './helpers/sync-transport-contract.ts';

/**
 * §9: every HTTP `SyncTransport` runs the same contract, including the 401 refresh and the 429
 * retry, against its provider's fake. (In-memory and local-folder transports run the
 * storage-only part of the contract in their own test files.)
 */

const noSleep = async () => {};
/** Hands out a new token after each forced refresh, like a real auth. */
function rotatingToken(prefix: string) {
  let n = 1;
  return async (opts?: { forceRefresh?: boolean }) => {
    if (opts?.forceRefresh) n += 1;
    return `${prefix}-${n}`;
  };
}

function googleDrive(): SyncTransportHarness {
  const faults = faultyFetch(new FakeDriveServer().fetch);
  const getValidAccessToken = rotatingToken('google');
  const transport = new GoogleDriveAppDataTransport({
    auth: {
      isConfigured: () => true,
      isConnected: async () => true,
      getSession: async () => null,
      getValidAccessToken,
      signIn: async () => null,
      handleRedirectCallback: async () => null,
      signOut: async () => {},
    },
    fetchImpl: faults.fetch,
    sleep: noSleep,
    random: () => 0,
  });
  return { transport, faults, throttlesWith403: true };
}

function dropbox(): SyncTransportHarness {
  const faults = faultyFetch(new FakeDropboxServer().fetch);
  const transport = new DropboxAppFolderTransport({
    getAccessToken: rotatingToken('dbx'),
    fetchImpl: faults.fetch,
    sleep: noSleep,
    random: () => 0,
  });
  return { transport, faults };
}

function oneDrive(): SyncTransportHarness {
  const faults = faultyFetch(new FakeGraphServer().fetch);
  const transport = new OneDriveAppFolderTransport({
    auth: { getValidAccessToken: async () => 'graph-token-1' },
    fetchImpl: faults.fetch,
    sleep: noSleep,
    random: () => 0,
  });
  return { transport, faults };
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
});
