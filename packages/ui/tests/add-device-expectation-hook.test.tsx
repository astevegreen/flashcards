// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  addDeviceExpectationResource,
  clearAddDeviceExpectation,
  saveAddDeviceExpectation,
  useAddDeviceExpectation,
} from '../src/sync/addDeviceExpectation.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTION = 'col-0190f5c2-1234-7abc-8def-0123456789ab';

function memoryKv(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    getKv: <T,>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    setKv: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
    deleteKv: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

describe('useAddDeviceExpectation', () => {
  it('re-renders when the stored link is read, saved and cleared', async () => {
    const kv = memoryKv({ add_device_link_v1: { provider: 'onedrive', collectionId: COLLECTION } });
    const seen: (string | undefined)[] = [];
    function Probe() {
      seen.push(useAddDeviceExpectation(kv)?.provider);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(<Probe />);
    });
    expect(seen.at(-1)).toBeUndefined();
    await act(async () => {
      await addDeviceExpectationResource(kv);
    });
    expect(seen.at(-1)).toBe('onedrive');
    // "Keep this device's cards" clears it: the component hears it without a sync state change.
    await act(async () => {
      await clearAddDeviceExpectation(kv);
    });
    expect(seen.at(-1)).toBeUndefined();
    await act(async () => {
      await saveAddDeviceExpectation(kv, { provider: 'dropbox', collectionId: COLLECTION });
    });
    expect(seen.at(-1)).toBe('dropbox');
    await act(async () => {
      root.unmount();
    });
  });
});
