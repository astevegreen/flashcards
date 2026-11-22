import { describe, expect, it } from 'vitest';
import {
  buildDropboxPkceAuthUrl,
  DropboxAppFolderTransport,
} from '../src/sync/dropbox-transport.ts';

describe('Phase 8 DropboxAppFolderTransport (§4.3, §15 Phase 8)', () => {
  it('supports list pagination, read, write with ifAbsent 409 handling, and PKCE URL', async () => {
    const store = new Map<string, Uint8Array>();

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url.endsWith('/2/files/list_folder')) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                '.tag': 'file',
                path_display: '/sync/v1/manifest.json',
                size: 12,
                server_modified: '2026-11-20T00:00:00Z',
              },
            ],
            cursor: 'cur-1',
            has_more: true,
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/2/files/list_folder/continue')) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                '.tag': 'file',
                path_display: '/sync/v1/devices/a/head.json',
                size: 40,
                server_modified: '2026-11-20T00:01:00Z',
              },
            ],
            cursor: 'cur-2',
            has_more: false,
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/2/files/upload')) {
        const arg = JSON.parse(headers['Dropbox-API-Arg'] ?? '{}') as {
          path: string;
          mode: string;
        };
        if (arg.mode === 'add' && store.has(arg.path)) {
          return new Response(JSON.stringify({ error_summary: 'path/conflict/file' }), {
            status: 409,
          });
        }
        const bytes = new Uint8Array(init?.body as ArrayBuffer);
        store.set(arg.path, bytes);
        return new Response(JSON.stringify({ path_display: arg.path }), { status: 200 });
      }

      if (url.endsWith('/2/files/download')) {
        const arg = JSON.parse(headers['Dropbox-API-Arg'] ?? '{}') as { path: string };
        const bytes = store.get(arg.path);
        if (!bytes) return new Response('not found', { status: 404 });
        return new Response(new Uint8Array(bytes).buffer, { status: 200 });
      }

      return new Response('not found', { status: 404 });
    };

    const transport = new DropboxAppFolderTransport({
      getAccessToken: async () => 'dbx-token',
      fetchImpl: fetchMock,
    });

    const listed = await transport.list('sync/v1');
    expect(listed.map((f) => f.path)).toEqual([
      'sync/v1/devices/a/head.json',
      'sync/v1/manifest.json',
    ]);

    const payload = new Uint8Array([10, 20, 30]);
    await transport.write('sync/v1/manifest.json', payload, { ifAbsent: true });
    // Second write with ifAbsent hits 409 conflict and silently succeeds as write-once
    await transport.write('sync/v1/manifest.json', new Uint8Array([99]), { ifAbsent: true });
    expect(await transport.read('sync/v1/manifest.json')).toEqual(payload);

    await expect(transport.read('../etc/passwd')).rejects.toThrow(/Unsafe Dropbox/);

    const authUrl = buildDropboxPkceAuthUrl({
      clientId: 'dbx-client',
      redirectUri: 'https://app.example/callback',
      codeChallenge: 'challenge-123',
      state: 'state-xyz',
    });
    expect(authUrl).toContain('token_access_type=offline');
    expect(authUrl).toContain('code_challenge_method=S256');
  });
});
