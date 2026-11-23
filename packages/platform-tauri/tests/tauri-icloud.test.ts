import { describe, expect, it } from 'vitest';
import { SyncTransportError } from '@flash/core';
import {
  createTauriICloudDocumentPlugin,
  createTauriPlatform,
  probeICloudAvailable,
  resolveTauriICloudOptions,
  type TauriInvoke,
} from '../src/index.ts';

interface Call {
  cmd: string;
  args: unknown;
  options: { headers: Record<string, string> } | undefined;
}

/** A fake of the Rust commands in `apps/desktop/src-tauri/src/icloud.rs`, over an in-memory map. */
function fakeRust(opts: { available?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const invoke = (async (cmd: string, args?: unknown, options?: Call['options']) => {
    calls.push({ cmd, args, options });
    if (cmd === 'icloud_available') return opts.available ?? true;
    if (opts.available === false) {
      throw { code: 'AUTH_REQUIRED', message: 'iCloud Drive is not available.' };
    }
    if (cmd === 'icloud_list_files') {
      const { prefix } = args as { prefix: string };
      return [...files.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([path, data]) => ({ path, size: data.byteLength, updatedAt: 1000 }));
    }
    if (cmd === 'icloud_read_file') {
      const data = files.get((args as { path: string }).path);
      if (!data) throw { code: 'NOT_FOUND', message: 'not found' };
      // Tauri hands a raw `Response` to the WebView as an ArrayBuffer.
      return data.slice().buffer;
    }
    if (cmd === 'icloud_write_file') {
      const path = decodeURIComponent(options?.headers['x-icloud-path'] ?? '');
      if (options?.headers['x-icloud-if-absent'] === '1' && files.has(path)) {
        throw { code: 'ALREADY_EXISTS', message: 'exists' };
      }
      files.set(path, new Uint8Array(args as Uint8Array));
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  }) as TauriInvoke;
  return { invoke, files, calls };
}

const bytes = (s: string) => new TextEncoder().encode(s);

function openICloud(platform: ReturnType<typeof createTauriPlatform>) {
  if (!platform.createICloudTransport) throw new Error('no iCloud transport');
  return platform.createICloudTransport();
}

describe('macOS iCloud Drive transport (Tauri)', () => {
  it('round-trips files through the Rust commands with raw bytes and the same paths as iOS', async () => {
    const rust = fakeRust();
    const platform = createTauriPlatform({
      deviceId: 'mac',
      iCloudPlugin: createTauriICloudDocumentPlugin(rust.invoke),
    });
    expect(platform.iCloudSyncSupported).toBe(true);
    const transport = await openICloud(platform);

    await transport.write('sync/dev a/한.seg', bytes('abc'), { ifAbsent: true });
    await transport.write('/sync/manifest.json', bytes('{}'));

    // The path is URI-encoded in a header; the body is the bytes themselves.
    const write = rust.calls.find((c) => c.cmd === 'icloud_write_file');
    expect(write?.args).toBeInstanceOf(Uint8Array);
    expect(write?.options?.headers).toEqual({
      'x-icloud-path': encodeURIComponent('sync/dev a/한.seg'),
      'x-icloud-if-absent': '1',
    });
    expect([...rust.files.keys()]).toEqual(['sync/dev a/한.seg', 'sync/manifest.json']);

    expect(await transport.list('sync/')).toEqual([
      { path: 'sync/dev a/한.seg', size: 3, updatedAt: 1000 },
      { path: 'sync/manifest.json', size: 2, updatedAt: 1000 },
    ]);
    expect(new TextDecoder().decode(await transport.read('sync/manifest.json'))).toBe('{}');
  });

  it('turns Rust error codes into SyncTransportErrors', async () => {
    const rust = fakeRust();
    const transport = await openICloud(
      createTauriPlatform({
        deviceId: 'mac',
        iCloudPlugin: createTauriICloudDocumentPlugin(rust.invoke),
      }),
    );

    await transport.write('sync/a.seg', bytes('1'), { ifAbsent: true });
    await expect(
      transport.write('sync/a.seg', bytes('2'), { ifAbsent: true }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    const missing = await transport.read('sync/none.seg').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(SyncTransportError);
    expect(missing).toMatchObject({ code: 'NOT_FOUND', message: 'not found' });
    // Unsafe paths never reach Rust.
    await expect(transport.read('../x')).rejects.toThrow(/Unsafe/);
  });

  it('asks the user to turn on iCloud Drive when it is off', async () => {
    const rust = fakeRust({ available: false });
    const platform = createTauriPlatform({
      deviceId: 'mac',
      iCloudPlugin: createTauriICloudDocumentPlugin(rust.invoke),
    });
    await expect(openICloud(platform)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('has no iCloud option unless the boot passes the plugin', () => {
    const platform = createTauriPlatform({ deviceId: 'win' });
    expect(platform.iCloudSyncSupported).toBeUndefined();
    expect(platform.createICloudTransport).toBeUndefined();
  });

  it('probes availability with a timeout and treats errors as unavailable', async () => {
    expect(await probeICloudAvailable(createTauriICloudDocumentPlugin(fakeRust().invoke))).toBe(
      true,
    );
    expect(
      await probeICloudAvailable(
        createTauriICloudDocumentPlugin(fakeRust({ available: false }).invoke),
      ),
    ).toBe(false);
    const failing = createTauriICloudDocumentPlugin((async () => {
      throw new Error('command not found');
    }) as TauriInvoke);
    expect(await probeICloudAvailable(failing)).toBe(false);
    const hanging = createTauriICloudDocumentPlugin((() => new Promise(() => {})) as TauriInvoke);
    expect(await probeICloudAvailable(hanging, 10)).toBe(false);
  });
});

describe('macOS desktop boot: iCloud options', () => {
  it('keeps a saved iCloud connection usable when the launch probe times out', async () => {
    // A Mac already syncing with iCloud (saved provider `icloud`) whose iCloud daemon is slow
    // at launch: the probe gives up, but the transport must still be there.
    let slow = true;
    const rust = fakeRust();
    const invoke = (async (cmd: string, ...rest: unknown[]) => {
      if (cmd === 'icloud_supported') return true;
      if (cmd === 'icloud_available' && slow) return new Promise(() => {});
      return (rust.invoke as (...a: unknown[]) => Promise<unknown>)(cmd, ...rest);
    }) as TauriInvoke;

    const options = await resolveTauriICloudOptions(invoke, 10);
    expect(options.iCloudPlugin).toBeDefined();
    expect(options.iCloudAvailableAtLaunch).toBe(false);

    const platform = createTauriPlatform({ deviceId: 'mac', ...options });
    expect(platform.iCloudSyncSupported).toBe(true);
    expect(platform.iCloudAvailableAtLaunch).toBe(false);

    // What `resolveActiveTransport(ctx, 'icloud')` does on the next sync cycle.
    slow = false;
    const transport = await platform.createICloudTransport?.();
    expect(transport).toBeDefined();
    await transport?.write('sync/manifest.json', bytes('{}'));
    expect(rust.files.has('sync/manifest.json')).toBe(true);
  });

  it('marks iCloud available at launch when the probe answers in time', async () => {
    const rust = fakeRust();
    const invoke = (async (cmd: string, ...rest: unknown[]) =>
      cmd === 'icloud_supported'
        ? true
        : (rust.invoke as (...a: unknown[]) => Promise<unknown>)(cmd, ...rest)) as TauriInvoke;
    const options = await resolveTauriICloudOptions(invoke);
    expect(options.iCloudAvailableAtLaunch).toBe(true);
  });

  it('offers no iCloud on Windows and Linux, or when the command is missing', async () => {
    expect(await resolveTauriICloudOptions((async () => false) as TauriInvoke)).toEqual({});
    expect(
      await resolveTauriICloudOptions((async () => {
        throw new Error('command icloud_supported not found');
      }) as TauriInvoke),
    ).toEqual({});
  });
});
