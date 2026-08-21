import type { AutomationExternalContentSource, AutomationWakeMode } from '../automation/index.js';
import type { AutomationExecutionPolicy } from '../automation/index.js';
import { readReasoningEffortLevel } from '../providers/reasoning-effort.js';
import {
  isJsonRecord,
  missingScopes,
  readChannelConversationKind,
  readChannelLifecycleAction,
  scopeMatches,
  type JsonRecord,
} from './http/route-helpers.js';

export type { ChannelConversationKind, ChannelLifecycleAction, JsonRecord } from './http/route-helpers.js';
export {
  isJsonRecord,
  missingScopes,
  readChannelConversationKind,
  readChannelLifecycleAction,
  scopeMatches,
} from './http/route-helpers.js';

export function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return undefined;
}

export function resolveGatewayPathTemplate(
  template: string,
  query?: Record<string, unknown>,
  body?: unknown,
): { readonly path: string | null; readonly missing: readonly string[] } {
  const bodyRecord = isJsonRecord(body) ? body : null;
  const missingParams: string[] = [];
  const path = template.replace(/\{([^}]+)\}/g, (_full, rawKey: string) => {
    const key = rawKey.trim();
    const queryValue = query?.[key];
    const bodyValue = bodyRecord?.[key];
    const value = typeof queryValue === 'string' || typeof queryValue === 'number'
      ? queryValue
      : typeof bodyValue === 'string' || typeof bodyValue === 'number'
        ? bodyValue
        : null;
    if (value === null) {
      missingParams.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(String(value));
  });
  return missingParams.length > 0 ? { path: null, missing: missingParams } : { path, missing: [] };
}

export function readAutomationWakeMode(value: unknown): AutomationWakeMode | undefined {
  return value === 'now' || value === 'next-heartbeat' ? value : undefined;
}

export function readAutomationReasoningEffort(value: unknown): AutomationExecutionPolicy['reasoningEffort'] | undefined {
  return readReasoningEffortLevel(value);
}

export function readExternalContentSource(value: unknown): AutomationExternalContentSource | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim() as AutomationExternalContentSource;
  }
  if (value && typeof value === 'object') {
    return value as AutomationExternalContentSource;
  }
  return undefined;
}

/**
 * Read a response body to text with a hard byte ceiling. Returns
 * `{ ok:false }` (and cancels the body) when the ceiling is exceeded, the
 * caller aborts and reports a structured error instead of buffering forever.
 */
export async function readBodyBounded(response: Response, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; bytesRead: number }> {
  const body = response.body;
  if (!body) return { ok: true, text: '' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, bytesRead: total };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}
