import { canUseCloudSync } from '@flash/core/license';
import { useState } from 'react';
import { useApp, type AppContextValue } from '../state/AppContext.tsx';
import type { AddDeviceProvider } from './addDeviceLink.ts';

type Connectors = Pick<
  AppContextValue,
  | 'connectGoogleDrive'
  | 'connectDropbox'
  | 'connectOneDrive'
  | 'connectICloud'
  | 'connectLocalFolder'
>;

/** Starts the provider's own connect flow (a sign-in redirect for the cloud ones on the web). */
async function runConnect(app: Connectors, kind: AddDeviceProvider): Promise<boolean> {
  switch (kind) {
    case 'google_drive':
      await app.connectGoogleDrive();
      return true;
    case 'dropbox':
      await app.connectDropbox();
      return true;
    case 'onedrive':
      await app.connectOneDrive();
      return true;
    case 'icloud':
      await app.connectICloud();
      return true;
    case 'local_folder':
      return app.connectLocalFolder();
  }
}

export interface ConnectSyncProvider {
  connect: (kind: AddDeviceProvider) => Promise<void>;
  /** The provider whose connect flow is running. */
  connecting: AddDeviceProvider | undefined;
  error: string | undefined;
}

/** Connects a storage connector from "Sync my devices", behind the same unlock gate as Settings. */
export function useConnectSyncProvider(): ConnectSyncProvider {
  const app = useApp();
  const [connecting, setConnecting] = useState<AddDeviceProvider | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const connect = async (kind: AddDeviceProvider) => {
    if (connecting !== undefined) return;
    const gate = canUseCloudSync(app.entitlement);
    if (!gate.allowed) {
      setError(gate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
    setError(undefined);
    setConnecting(kind);
    try {
      await runConnect(app, kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(undefined);
    }
  };

  return { connect, connecting, error };
}
