import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { checkAddDeviceCollection } from './addDeviceLink.ts';
import {
  addDeviceExpectationResource,
  clearAddDeviceExpectation,
  peekAddDeviceExpectation,
} from './addDeviceExpectation.ts';
import { syncProviderInfo } from './syncProviders.ts';

/**
 * On a device opened with an add-device link: once it syncs, says whether it reached the same
 * collection as the device that showed the code (the usual slip is signing in to a different
 * account). Decided from a record the app read at startup, so the line is there from the first
 * paint of the screen; it keeps a reserved height while the first sync runs. Someone who means
 * to keep the other collection (or whose first sync never confirms one) dismisses it, which
 * forgets the stored link on this device.
 */
export function AddDeviceCollectionNotice({
  onDismiss,
}: Readonly<{
  /** Also told when the user dismisses the notice (the stored link is forgotten either way). */
  onDismiss?: () => void;
}> = {}) {
  const { platform, syncState, meta } = useApp();
  const storage = platform.storage;
  const [expected, setExpected] = useState(() => peekAddDeviceExpectation(storage));
  const check = checkAddDeviceCollection(expected, {
    provider: syncState.provider,
    collectionId: meta?.collectionId,
  });

  // Normally settled long before this screen mounts; this only covers a very early mount. The
  // value is kept for as long as the screen stays up, so "Connected…" does not vanish at once.
  useEffect(() => {
    let live = true;
    void addDeviceExpectationResource(storage).then((value) => {
      if (live && value !== undefined) setExpected(value);
    });
    return () => {
      live = false;
    };
  }, [storage]);

  useEffect(() => {
    if (check === 'match') void clearAddDeviceExpectation(storage);
  }, [check, storage]);

  if (!expected || check === 'not_applicable') return null;
  const label = syncProviderInfo(expected.provider).label;
  const mismatch = check === 'mismatch';

  const dismiss = () => {
    setExpected(undefined);
    void clearAddDeviceExpectation(storage);
    onDismiss?.();
  };

  return (
    <div
      data-testid="add-device-collection-check"
      data-check={check}
      className={`flex min-h-12 min-w-0 flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-left text-xs ${
        mismatch
          ? 'border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
          : 'text-[var(--muted)]'
      }`}
    >
      <output
        data-testid="add-device-collection-check-text"
        aria-live="polite"
        className="block min-w-0 flex-1 basis-48 break-words"
      >
        {check === 'pending' && `Connecting to your other device's collection on ${label}…`}
        {check === 'match' && 'Connected to the same collection as your other device.'}
        {mismatch &&
          `This ${label} account holds a different collection from the device that showed the code. To join that one, disconnect and sign in with the account your other device uses.`}
      </output>
      {check !== 'match' && (
        <button
          type="button"
          data-testid="add-device-collection-dismiss"
          onClick={dismiss}
          className="min-h-11 shrink-0 rounded-lg px-2 py-1 font-semibold underline hover:opacity-80"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export default AddDeviceCollectionNotice;
