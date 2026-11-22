import { useApp } from '../state/AppContext.tsx';
import { peekAddDeviceExpectation } from './addDeviceExpectation.ts';
import type { AddDeviceLink, AddDeviceProvider } from './addDeviceLink.ts';
import { describeSyncProvider } from './syncProviderLabel.ts';
import { planSyncMyDevices, syncProviderInfo, type SyncProviderInfo } from './syncProviders.ts';
import { useConnectSyncProvider } from './useConnectSyncProvider.ts';

/**
 * Phase 14 "One Sync my devices button". One main button connects the default provider (iCloud
 * on Apple devices that have it, Google Drive elsewhere; an add-device link's provider when this
 * device was opened with one), and the other configured providers are listed as alternatives.
 * Sign-in always happens in the provider's own page or the system account picker.
 *
 * Variants: `panel` (empty screen and the after-first-session prompt) lists the alternatives
 * itself; `settings` shows only the main button, because Settings > Cloud Sync already lists every
 * provider right under it. Never in the initial study bundle: it ships with the empty-collection,
 * prompt and Settings chunks (§8). The status line has a reserved height so nothing moves.
 */

const PRIMARY_CLASS =
  'min-h-11 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50';
const PANEL_CLASS =
  'flex w-full max-w-md min-w-0 flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-left';
const OPTION_CLASS =
  'min-h-11 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold break-words hover:bg-[var(--surface-2)] disabled:opacity-50';

function LinkNote({
  link,
  primary,
}: Readonly<{ link: AddDeviceLink | undefined; primary: AddDeviceProvider | undefined }>) {
  if (!link || link.provider !== primary) return null;
  const info = syncProviderInfo(link.provider);
  const account =
    link.provider === 'icloud'
      ? 'Make sure this device uses the same Apple ID.'
      : 'Sign in with the same account here.';
  return (
    <p data-testid="sync-my-devices-link-note" className="text-sm break-words">
      Your other device syncs with <strong>{info.label}</strong>. {account}
    </p>
  );
}

function UnavailableLinkNote({ kind }: Readonly<{ kind: AddDeviceProvider | undefined }>) {
  if (kind === undefined) return null;
  return (
    <p data-testid="sync-my-devices-link-note" className="text-sm break-words">
      Your other device syncs with <strong>{syncProviderInfo(kind).label}</strong>, which this
      device can't use. Choose another service on both devices.
    </p>
  );
}

function connectingText(kind: AddDeviceProvider): string {
  if (kind === 'local_folder') return 'Choose the folder to sync…';
  if (kind === 'icloud') return 'Connecting to iCloud Drive…';
  return `Opening ${syncProviderInfo(kind).label} sign-in…`;
}

function PrimaryAction({
  info,
  variant,
  busy,
  onConnect,
}: Readonly<{
  info: SyncProviderInfo | undefined;
  variant: 'panel' | 'settings';
  busy: boolean;
  onConnect: (kind: AddDeviceProvider) => void;
}>) {
  if (!info) {
    return <p className="text-sm text-[var(--muted)]">No sync service is set up in this build.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-testid="sync-my-devices-primary"
        disabled={busy}
        onClick={() => onConnect(info.kind)}
        className={`${PRIMARY_CLASS} self-start`}
      >
        {variant === 'settings' ? 'Sync my devices' : `Continue with ${info.name}`}
      </button>
      <p className="text-xs break-words text-[var(--muted)]">
        {variant === 'settings' && <>Uses {info.name}. </>}
        {info.hint}
      </p>
    </div>
  );
}

function Alternatives({
  kinds,
  busy,
  onConnect,
}: Readonly<{
  kinds: readonly AddDeviceProvider[];
  busy: boolean;
  onConnect: (kind: AddDeviceProvider) => void;
}>) {
  if (kinds.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-semibold text-[var(--muted)]">Or use</p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={`sync-option-${kind}`}
            disabled={busy}
            onClick={() => onConnect(kind)}
            className={OPTION_CLASS}
          >
            {syncProviderInfo(kind).label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SyncMyDevicesPanel({
  variant,
  fromEmptyScreen = false,
  onOpenSettings,
}: Readonly<{
  variant: 'panel' | 'settings';
  /** Adds the line about the add-device QR code / link from the other device. */
  fromEmptyScreen?: boolean;
  /** `panel` only: a link to every sync setting. */
  onOpenSettings?: (() => void) | undefined;
}>) {
  const { platform, syncState, addDeviceLink: openedLink } = useApp();
  const { connect, connecting, error } = useConnectSyncProvider();
  // Back from a sign-in that did not finish, the page-load link is gone but the stored one still
  // says which provider the other device uses.
  const addDeviceLink =
    openedLink ??
    (syncState.provider === 'none' ? peekAddDeviceExpectation(platform.storage) : undefined);
  const plan = planSyncMyDevices(platform, addDeviceLink);
  const isPanel = variant === 'panel';
  // In the panel, a device that already syncs just says so (unless a link asks to switch).
  const showConnected =
    isPanel &&
    addDeviceLink === undefined &&
    syncState.provider !== 'none' &&
    syncState.provider !== 'dev_channel';
  const busy = connecting !== undefined;
  const onConnect = (kind: AddDeviceProvider) => void connect(kind);
  const status = connecting === undefined ? (error ?? '') : connectingText(connecting);

  return (
    <section
      aria-label="Sync my devices"
      data-testid="sync-my-devices"
      className={isPanel ? PANEL_CLASS : 'flex min-w-0 flex-col gap-2'}
    >
      {isPanel && <h2 className="text-base font-bold">Sync my devices</h2>}
      {fromEmptyScreen && (
        <p className="text-sm break-words text-[var(--muted)]">
          On your other device, open Settings, then Cloud Sync, then <strong>Add a device</strong>,
          and scan its QR code or open its link here. Or choose the service it syncs with:
        </p>
      )}
      <LinkNote link={addDeviceLink} primary={plan.primary} />
      <UnavailableLinkNote kind={plan.unavailableLinkProvider} />
      {showConnected ? (
        <p className="text-sm break-words">
          This device syncs with{' '}
          <strong>{describeSyncProvider(syncState.provider, syncState.localFolderName)}</strong>.
        </p>
      ) : (
        <>
          <PrimaryAction
            info={plan.primary === undefined ? undefined : syncProviderInfo(plan.primary)}
            variant={variant}
            busy={busy}
            onConnect={onConnect}
          />
          {isPanel && <Alternatives kinds={plan.alternatives} busy={busy} onConnect={onConnect} />}
        </>
      )}
      <output
        data-testid="sync-my-devices-status"
        aria-live="polite"
        className={`block min-h-10 text-xs break-words ${error === undefined ? 'text-[var(--muted)]' : 'text-[var(--danger,#dc2626)]'}`}
      >
        {status}
      </output>
      {isPanel && onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="min-h-11 self-start rounded-lg px-1 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)]"
        >
          All sync settings
        </button>
      )}
    </section>
  );
}

export default SyncMyDevicesPanel;
