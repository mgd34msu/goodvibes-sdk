/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readTextBodyWithinLimit, DEFAULT_MAX_REQUEST_BODY_BYTES } from '../utils/request-body.js';

export const DEFAULT_WEBHOOK_MAX_BYTES = DEFAULT_MAX_REQUEST_BODY_BYTES;

export function constantTimeEquals(expected: string, provided: string): boolean {
  if (!expected || !provided || expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export function readBearerOrHeaderToken(req: Request, headerName: string): string {
  return (
    req.headers.get(headerName)
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? ''
  ).trim();
}

export function parseJsonRecord(rawBody: string): Record<string, unknown> | Response {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

export { readTextBodyWithinLimit };

export function verifySha256HmacSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string,
  prefix = 'sha256=',
): boolean {
  if (!secret || !signatureHeader.startsWith(prefix)) return false;
  const expected = `${prefix}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEquals(expected, signatureHeader);
}
