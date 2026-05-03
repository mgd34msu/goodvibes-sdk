import type { JsonRecord } from '../helpers.js';
import { readTextBodyWithinLimit } from '../../utils/request-body.js';

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

export async function parseDaemonJsonBody(req: Request): Promise<JsonRecord | Response> {
  try {
    const text = await readTextBodyWithinLimit(req, MAX_JSON_BODY_BYTES);
    if (text instanceof Response) return text;
    return parseDaemonJsonText(text);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

export async function parseOptionalDaemonJsonBody(req: Request): Promise<JsonRecord | null | Response> {
  const raw = await readTextBodyWithinLimit(req, MAX_JSON_BODY_BYTES);
  if (raw instanceof Response) return raw;
  if (!raw.trim()) return null;
  return parseDaemonJsonText(raw);
}

export function parseDaemonJsonText(rawBody: string): JsonRecord | Response {
  try {
    return JSON.parse(rawBody) as JsonRecord;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
