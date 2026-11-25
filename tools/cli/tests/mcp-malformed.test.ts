import { describe, expect, it } from 'vitest';
import { handleMcpMessage } from '../src/mcp.ts';

// C26: one malformed JSON-RPC line must get an error reply, never crash the server.
const ctx = { mirrorPath: '.', inboxDir: '.', nowMs: () => 0 };

describe('handleMcpMessage (C26)', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 42],
    ['a batch', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]],
  ])('answers %s with -32600 and a null id', (_label, raw) => {
    expect(handleMcpMessage(raw, ctx)).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600 },
    });
  });

  it('answers an object without a method with -32600 and its id', () => {
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 7 }, ctx)).toMatchObject({
      id: 7,
      error: { code: -32600 },
    });
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 8, method: 3 }, ctx)).toMatchObject({
      id: 8,
      error: { code: -32600 },
    });
  });

  it('rejects an id that is not a string, number or null', () => {
    expect(handleMcpMessage({ jsonrpc: '2.0', id: {}, method: 'tools/list' }, ctx)).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
  });

  it('answers non-object params with -32602', () => {
    expect(
      handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: 'x' }, ctx),
    ).toMatchObject({ id: 9, error: { code: -32602 } });
    expect(
      handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: null }, ctx),
    ).toMatchObject({ id: 10, error: { code: -32602 } });
  });

  it('ignores a client reply and a notification', () => {
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 1, result: {} }, ctx)).toBeNull();
    expect(
      handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx),
    ).toBeNull();
  });

  it('still serves a well-formed request', () => {
    const resp = handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx);
    expect(resp?.id).toBe(1);
    expect(resp?.result).toBeTruthy();
  });
});
