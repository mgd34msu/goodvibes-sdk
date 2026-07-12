/**
 * Streamable HTTP request-metadata headers (revision 2026-07-28).
 *
 * The transport mirrors selected JSON-RPC body fields into HTTP headers so
 * intermediaries can route without parsing the body:
 * - `Mcp-Method` on every request; `Mcp-Name` on tools/call, resources/read,
 *   prompts/get (from `params.name` / `params.uri`).
 * - Tool parameters annotated with `x-mcp-header` in the tool's inputSchema
 *   are mirrored as `Mcp-Param-{Name}` headers.
 * - Values that are not header-safe ASCII are carried as
 *   `=?base64?{base64(utf8)}?=`.
 */
import { isRecord } from '../utils/record-coerce.js';

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/** RFC 9110 token syntax for header names (1*tchar). */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isHeaderSafeAscii(value: string): boolean {
  if (value.length === 0) return true;
  if (value !== value.trim()) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Visible ASCII (0x21-0x7E), space, and horizontal tab are allowed.
    if (code !== 0x20 && code !== 0x09 && (code < 0x21 || code > 0x7e)) return false;
  }
  return true;
}

function matchesSentinelPattern(value: string): boolean {
  return value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX);
}

/**
 * Encode a header value per the transport's value-encoding rules: plain when
 * header-safe ASCII, otherwise the base64 sentinel form. Plain values that
 * would themselves look like the sentinel are encoded to avoid ambiguity.
 */
export function encodeHeaderValue(value: string): string {
  if (isHeaderSafeAscii(value) && !matchesSentinelPattern(value)) return value;
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `${BASE64_SENTINEL_PREFIX}${encoded}${BASE64_SENTINEL_SUFFIX}`;
}

/** Methods whose params carry a name/uri mirrored into Mcp-Name. */
const NAMED_METHODS: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

/** Build Mcp-Method and (when applicable) Mcp-Name for a request. */
export function buildStandardRequestHeaders(method: string, params: unknown): Record<string, string> {
  const headers: Record<string, string> = { 'Mcp-Method': method };
  const nameField = NAMED_METHODS[method];
  if (nameField && isRecord(params)) {
    const value = params[nameField];
    if (typeof value === 'string') {
      headers['Mcp-Name'] = encodeHeaderValue(value);
    }
  }
  return headers;
}

interface HeaderAnnotation {
  readonly headerName: string;
  readonly path: readonly string[];
}

/**
 * Collect `x-mcp-header` annotations that are statically reachable from the
 * schema root through `properties` keys only. Returns null when any
 * annotation in the schema violates the constraints (which makes the whole
 * tool definition invalid per the specification).
 */
export function collectHeaderAnnotations(inputSchema: unknown): HeaderAnnotation[] | null {
  const found: HeaderAnnotation[] = [];
  const seen = new Set<string>();
  let invalid = false;

  const visit = (node: unknown, path: readonly string[], reachable: boolean): void => {
    if (!isRecord(node)) return;
    const annotation = node['x-mcp-header'];
    if (annotation !== undefined) {
      if (
        typeof annotation !== 'string'
        || annotation.length === 0
        || !HEADER_NAME_TOKEN.test(annotation)
        || !reachable
        || (node.type !== 'string' && node.type !== 'integer' && node.type !== 'boolean')
      ) {
        invalid = true;
        return;
      }
      const key = annotation.toLowerCase();
      if (seen.has(key)) {
        invalid = true;
        return;
      }
      seen.add(key);
      found.push({ headerName: annotation, path });
    }
    // Only chains made solely of `properties` keys stay reachable; any other
    // structural keyword (items, oneOf, $ref, if/then, ...) breaks the chain.
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isRecord(value)) {
        for (const [propName, propSchema] of Object.entries(value)) {
          visit(propSchema, [...path, propName], reachable);
        }
      } else if (isRecord(value) || Array.isArray(value)) {
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) visit(child, path, false);
      }
    }
  };

  visit(inputSchema, [], true);
  return invalid ? null : found;
}

/** True when the tool definition's x-mcp-header annotations are all valid. */
export function hasValidHeaderAnnotations(inputSchema: unknown): boolean {
  return collectHeaderAnnotations(inputSchema) !== null;
}

function valueAtPath(args: unknown, path: readonly string[]): unknown {
  let current: unknown = args;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Build `Mcp-Param-{Name}` headers for a tools/call from the most recently
 * obtained inputSchema. Absent or null argument values omit the header.
 */
export function buildParamHeaders(
  inputSchema: unknown,
  args: Record<string, unknown>,
): Record<string, string> {
  const annotations = collectHeaderAnnotations(inputSchema);
  if (!annotations) return {};
  const headers: Record<string, string> = {};
  for (const annotation of annotations) {
    const value = valueAtPath(args, annotation.path);
    if (value === undefined || value === null) continue;
    let text: string;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'boolean') text = value ? 'true' : 'false';
    else if (typeof value === 'number' && Number.isInteger(value)) text = String(value);
    else continue;
    headers[`Mcp-Param-${annotation.headerName}`] = encodeHeaderValue(text);
  }
  return headers;
}
