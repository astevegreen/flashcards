import { useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import {
  buildAddDeviceDeepLink,
  buildAddDeviceUrl,
  isAddDeviceProvider,
  isShareableCollectionId,
  type AddDeviceProvider,
} from './addDeviceLink.ts';
import { QrCodeSvg } from './QrCodeSvg.tsx';
import { syncProviderInfo } from './syncProviders.ts';

/**
 * Phase 14 "Add another device", shown on a device that already syncs: a QR code and a short link
 * that tell a new device which provider and which collection to connect to. They carry nothing
 * else (no token, secret, email or account name); the new device signs in by itself.
 *
 * On the web the link points at this web app's own address. Inside the native shells that address
 * (`capacitor://`, `tauri://`, or a `localhost` origin) means nothing on another device, so they
 * show a `flashcards://add-device` link instead, which opens the app on a device that has it
 * installed (no App Links or universal links yet: a phone without the app gets nothing from it).
 */

function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
    __TAURI_INTERNALS__?: unknown;
  };
  return w.Capacitor?.isNativePlatform?.() === true || w.__TAURI_INTERNALS__ !== undefined;
}

/** This web app's address without any query or hash, or `undefined` inside a native shell. */
export function addDeviceLinkBase(): string | undefined {
  if (typeof window === 'undefined' || isNativeShell()) return undefined;
  const { protocol, origin, pathname } = window.location;
  if (protocol !== 'https:' && protocol !== 'http:') return undefined;
  return `${origin}${pathname}`;
}

const NOTE_CLASS = 'text-sm break-words text-[var(--muted)]';

function ShareLink({
  url,
  providerLabel,
  plainText = false,
}: Readonly<{ url: string; providerLabel: string; plainText?: boolean }>) {
  const [copyStatus, setCopyStatus] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus('Link copied.');
    } catch {
      setCopyStatus("Couldn't copy. Select the link and copy it instead.");
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-4">
      <QrCodeSvg text={url} label={`QR code: connect a new device to ${providerLabel}`} />
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
        {plainText ? (
          <code data-testid="add-device-link" className="font-mono text-xs break-all">
            {url}
          </code>
        ) : (
          <a
            data-testid="add-device-link"
            href={url}
            className="font-mono text-xs break-all text-[var(--accent)] underline"
          >
            {url}
          </a>
        )}
        <button
          type="button"
          data-testid="add-device-copy-btn"
          onClick={() => void copy()}
          className="min-h-11 self-start rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
        >
          Copy link
        </button>
        <output
          data-testid="add-device-copy-status"
          aria-live="polite"
          className="block min-h-8 text-xs break-words text-[var(--muted)]"
        >
          {copyStatus}
        </output>
      </div>
    </div>
  );
}

function AddDeviceBody({
  provider,
  collectionId,
}: Readonly<{ provider: AddDeviceProvider; collectionId: string | undefined }>) {
  const info = syncProviderInfo(provider);
  if (!isShareableCollectionId(collectionId)) {
    return (
      <p data-testid="add-device-waiting" className={NOTE_CLASS}>
        Your add-device code appears here after this device's first sync with {info.label}.
      </p>
    );
  }
  const base = addDeviceLinkBase();
  const native = base === undefined && isNativeShell();
  const account =
    provider === 'icloud' ? 'uses the same Apple ID' : `signs in to the same ${info.label} account`;
  if (base === undefined && !native) {
    return (
      <p data-testid="add-device-instructions" className={NOTE_CLASS}>
        On your new device, open the app, choose <strong>Sync my devices</strong> and pick{' '}
        <strong>{info.label}</strong>. It then {account} and gets everything from here.
      </p>
    );
  }
  if (base === undefined) {
    return (
      <>
        <p className={NOTE_CLASS}>
          Install the app on your new device, then scan this code with its camera or open the link
          there. It tells the app to use {info.label} and this collection. It contains no passwords
          or keys: the new device {account} by itself. Or open the app there, choose{' '}
          <strong>Sync my devices</strong> and pick <strong>{info.label}</strong>.
        </p>
        <ShareLink
          url={buildAddDeviceDeepLink({ provider, collectionId })}
          providerLabel={info.label}
          plainText
        />
      </>
    );
  }
  return (
    <>
      <p className={NOTE_CLASS}>
        Scan this code with your new device's camera, or open the link on it. It tells the new
        device to use {info.label} and this collection. It contains no passwords or keys: the new
        device {account} by itself.
      </p>
      <ShareLink
        url={buildAddDeviceUrl(base, { provider, collectionId })}
        providerLabel={info.label}
      />
    </>
  );
}

export function AddDevicePanel() {
  const { syncState, meta } = useApp();
  const provider = syncState.provider;
  return (
    <section
      aria-label="Add a device"
      data-testid="add-device-panel"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
    >
      {isAddDeviceProvider(provider) ? (
        <AddDeviceBody provider={provider} collectionId={meta?.collectionId} />
      ) : (
        <p className={NOTE_CLASS}>
          Adding a device works when this device syncs with Google Drive, Dropbox, OneDrive, iCloud
          Drive or a folder.
        </p>
      )}
    </section>
  );
}

export default AddDevicePanel;
