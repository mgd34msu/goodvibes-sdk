/**
 * MCP protocol revision knowledge shared by the stdio and HTTP transports.
 *
 * Two eras exist:
 * - "modern" (revision 2026-07-28 and later): stateless; no initialize
 *   handshake; every request carries its protocol version, client identity,
 *   and client capabilities in `_meta`; servers implement `server/discover`.
 * - "legacy" (revision 2025-11-25 and earlier): an `initialize` handshake
 *   negotiates one version for the session.
 */
import { isRecord } from '../utils/record-coerce.js';

/** The stateless MCP revision (per-request `_meta`, no handshake). */
export const MCP_STATELESS_REVISION = '2026-07-28';

/** Handshake-based revisions this client can speak, newest first. */
export const MCP_LEGACY_REVISIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/** Every revision this client supports, newest first. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  MCP_STATELESS_REVISION,
  ...MCP_LEGACY_REVISIONS,
];

/** First revision that defined the MCP-Protocol-Version HTTP header. */
export const MCP_HTTP_VERSION_HEADER_SINCE = '2025-06-18';

// JSON-RPC error codes defined by the MCP specification.
export const MCP_ERROR_HEADER_MISMATCH = -32020;
export const MCP_ERROR_MISSING_CLIENT_CAPABILITY = -32021;
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const JSONRPC_METHOD_NOT_FOUND = -32601;

// `_meta` keys carried on every modern-era request.
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

export type McpEra = 'modern' | 'legacy';
export type McpTransportKind = 'stdio' | 'http';

/** The outcome of version negotiation, surfaced in diagnostics. */
export interface McpNegotiatedProtocol {
  readonly era: McpEra;
  readonly version: string;
  readonly transport: McpTransportKind;
}

export interface McpClientIdentity {
  readonly name: string;
  readonly version: string;
}

/** Revision identifiers are dates, so lexical order is chronological order. */
export function isModernVersion(version: string): boolean {
  return version >= MCP_STATELESS_REVISION;
}

/** Build the `_meta` object every modern-era request must carry. */
export function buildModernMeta(
  protocolVersion: string,
  clientInfo: McpClientIdentity,
  clientCapabilities: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: protocolVersion,
    [META_CLIENT_INFO]: { name: clientInfo.name, version: clientInfo.version },
    [META_CLIENT_CAPABILITIES]: clientCapabilities,
  };
}

/** Merge modern `_meta` into request params, preserving caller-supplied `_meta` keys. */
export function withModernMeta(params: unknown, meta: Record<string, unknown>): Record<string, unknown> {
  const base = isRecord(params) ? params : {};
  const existingMeta = isRecord(base._meta) ? base._meta : {};
  return { ...base, _meta: { ...existingMeta, ...meta } };
}

/** Pick the newest version both sides support, or null when there is none. */
export function selectMutualVersion(serverSupported: readonly string[]): string | null {
  for (const version of MCP_SUPPORTED_VERSIONS) {
    if (serverSupported.includes(version)) return version;
  }
  return null;
}

/**
 * A recognized modern JSON-RPC error code identifies a modern server during
 * era detection (the client retries/negotiates instead of falling back).
 */
export function isRecognizedModernErrorCode(code: number): boolean {
  return code === MCP_ERROR_HEADER_MISMATCH
    || code === MCP_ERROR_MISSING_CLIENT_CAPABILITY
    || code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION;
}

/** Extract `data.supported` from an UnsupportedProtocolVersionError, if present. */
export function parseSupportedVersionsFromError(errorData: unknown): string[] | null {
  if (!isRecord(errorData)) return null;
  const supported = errorData.supported;
  if (!Array.isArray(supported)) return null;
  const versions = supported.filter((v): v is string => typeof v === 'string');
  return versions.length > 0 ? versions : null;
}

/** Extract `supportedVersions` from a DiscoverResult, if well-formed. */
export function parseDiscoverSupportedVersions(result: unknown): string[] | null {
  if (!isRecord(result)) return null;
  const versions = result.supportedVersions;
  if (!Array.isArray(versions)) return null;
  const parsed = versions.filter((v): v is string => typeof v === 'string');
  return parsed.length > 0 ? parsed : null;
}

/**
 * Modern-era results carry `resultType`; `input_required` marks a Multi
 * Round-Trip Request interim result. Results from earlier-protocol servers
 * that omit the field are treated as complete, per the specification.
 */
export function isInputRequiredResult(result: unknown): result is {
  resultType: 'input_required';
  inputRequests?: Record<string, unknown>;
  requestState?: string;
} {
  return isRecord(result) && result.resultType === 'input_required';
}
