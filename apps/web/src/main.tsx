import { buildSampleDeckEvents, createEventFactory, createHlcState } from '@flash/core';
import { createWebPlatform, resolveDeviceFromUrl } from '@flash/platform-web';
import { FlashcardsApp } from '@flash/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function boot(): Promise<void> {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = import.meta.env.DEV || Boolean(resolved.slug);
  const platform = createWebPlatform({ isDevMode });

  let meta = await platform.storage.getDeviceMeta();
  if (!meta) {
    meta = {
      deviceId: platform.deviceId,
      seq: 0,
      hlc: createHlcState(platform.deviceId, Date.now()),
    };
    await platform.storage.setDeviceMeta(meta);
  }

  let events = await platform.storage.getAllEvents();

  // Agent-friendly no-login dev mode (§10.2): auto-seed sample decks on first empty launch
  if (events.length === 0 && isDevMode && !meta.seeded) {
    const factory = createEventFactory(meta.deviceId, meta.seq, meta.hlc);
    const seedEvents = buildSampleDeckEvents(factory, Date.now());
    await platform.storage.appendEvents(seedEvents);
    meta = {
      ...meta,
      seq: factory.getSeq(),
      hlc: factory.getHlc(),
      seeded: true,
    };
    await platform.storage.setDeviceMeta(meta);
    events = seedEvents;
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  createRoot(rootEl).render(
    <StrictMode>
      <FlashcardsApp platform={platform} initialEvents={events} initialMeta={meta} />
    </StrictMode>,
  );
}

void boot();
