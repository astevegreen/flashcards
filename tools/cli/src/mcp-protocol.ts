/**
 * MCP protocol version handling for the local server (Phase 13).
 *
 * Two eras are served on the same stdio process:
 * - **Modern** (`2026-07-28`): stateless. Every request names its version and client capabilities
 *   in `params._meta`; `server/discover` replaces the handshake; results carry
 *   `resultType: "complete"` and the server info in `_meta`.
 * - **Legacy** (`2024-11-05` … `2025-11-25`): the `initialize` handshake negotiates a version and
 *   later requests carry no version. Requests without a `_meta` version keep this behavior, so
 *   older clients (and scripts that skip the handshake) work unchanged.
 */

export const MCP_MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
/** Newest first: `initialize` answers with the first one when the client's is unknown. */
export const MCP_LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const MCP_SERVER_INFO = { name: 'flashcards-local-mcp', version: '0.2.0' } as const;

export const MCP_INSTRUCTIONS =
  "Read-only view of a local flashcards sync mirror or .flashpkg backup, plus propose_package to drop AI-made packages into the Inbox for review. Filters use the app's Phase 9 card filter.";

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const JSONRPC_INVALID_PARAMS = -32602;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export interface McpProtocolError {
  code: number;
  message: string;
  data?: unknown;
}

/** How a request is served: legacy (no `_meta` version) or modern at a supported version. */
export type McpRequestEra =
  | { era: 'legacy' }
  | { era: 'modern'; version: string }
  | { era: 'error'; error: McpProtocolError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the per-request `_meta` version of a modern request and checks it is supported. */
export function readRequestEra(params: Record<string, unknown> | undefined): McpRequestEra {
  const meta = params?.['_meta'];
  if (!isRecord(meta) || meta[META_PROTOCOL_VERSION] === undefined) return { era: 'legacy' };
  const requested = meta[META_PROTOCOL_VERSION];
  if (typeof requested !== 'string') {
    return {
      era: 'error',
      error: { code: JSONRPC_INVALID_PARAMS, message: `${META_PROTOCOL_VERSION} must be a string` },
    };
  }
  if (!(MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return {
      era: 'error',
      error: {
        code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
        message: 'Unsupported protocol version',
        data: { supported: [...MCP_MODERN_PROTOCOL_VERSIONS], requested },
      },
    };
  }
  if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
    return {
      era: 'error',
      error: {
        code: JSONRPC_INVALID_PARAMS,
        message: `Missing required _meta field: ${META_CLIENT_CAPABILITIES}`,
      },
    };
  }
  return { era: 'modern', version: requested };
}

/** The legacy handshake: echo the client's version when supported, else offer the newest. */
export function negotiateLegacyVersion(requested: unknown): string {
  const known = MCP_LEGACY_PROTOCOL_VERSIONS as readonly string[];
  return typeof requested === 'string' && known.includes(requested)
    ? requested
    : MCP_LEGACY_PROTOCOL_VERSIONS[0];
}

export function legacyInitializeResult(params: Record<string, unknown> | undefined): unknown {
  return {
    protocolVersion: negotiateLegacyVersion(params?.['protocolVersion']),
    capabilities: { tools: {} },
    serverInfo: MCP_SERVER_INFO,
    instructions: MCP_INSTRUCTIONS,
  };
}

/** `server/discover` (modern era): versions, capabilities and server info, no handshake state. */
export function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...MCP_MODERN_PROTOCOL_VERSIONS],
    capabilities: { tools: {} },
    instructions: MCP_INSTRUCTIONS,
  };
}

/** Adds the modern result envelope (`resultType`, server info) to a result object. */
export function withModernEnvelope(result: unknown): Record<string, unknown> {
  const base = isRecord(result) ? result : {};
  const meta = isRecord(base['_meta']) ? base['_meta'] : {};
  return {
    ...base,
    resultType: 'complete',
    _meta: { ...meta, [META_SERVER_INFO]: MCP_SERVER_INFO },
  };
}
