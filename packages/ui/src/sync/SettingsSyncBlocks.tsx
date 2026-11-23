import { useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { AddDeviceCollectionNotice } from './AddDeviceCollectionNotice.tsx';
import { isAddDeviceProvider } from './addDeviceLink.ts';
import { AddDevicePanel } from './AddDevicePanel.tsx';
import { SyncMyDevicesPanel } from './SyncMyDevicesPanel.tsx';

/**
 * Phase 14 pieces of Settings > Cloud Sync, kept out of SettingsScreen so its own logic stays
 * small. They ship in the Settings chunk (never the initial study bundle, §8).
 */

/** The one "Sync my devices" button while nothing syncs (or an add-device link names a provider). */
export function SettingsSyncMyDevices() {
  const { syncState, addDeviceLink } = useApp();
  if (syncState.provider !== 'none' && addDeviceLink === undefined) return null;
  return (
    <>
      <SyncMyDevicesPanel variant="settings" />
      <p className="text-xs font-semibold text-[var(--muted)]">Or choose a provider</p>
    </>
  );
}

/**
 * "Add a device" (QR code + link) on a device that syncs with a real provider, and the
 * add-device collection check on a device opened with such a link.
 */
export function SettingsAddDevice() {
  const { syncState } = useApp();
  const [open, setOpen] = useState(false);
  const canAddDevice = isAddDeviceProvider(syncState.provider) && !syncState.readOnly;
  return (
    <>
      {canAddDevice && (
        <div className="flex min-w-0 flex-col gap-2">
          <button
            type="button"
            data-testid="add-device-btn"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="self-start rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
          >
            Add a device
          </button>
          {open && <AddDevicePanel />}
        </div>
      )}
      <AddDeviceCollectionNotice />
    </>
  );
}
