import type { HookDefinition, HookResult, HookEvent } from '../types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { classifyHostTrustTier, extractHostname, emitSsrfDeny } from '../../tools/fetch/trust-tiers.js';

/**
 * HTTP hook runner.
 * POSTs the event JSON to the configured URL and parses the response as HookResult.
 */
export async function run(hook: HookDefinition, event: HookEvent): Promise<HookResult> {
  const url = hook.url;
  if (!url) {
    return { ok: false, error: 'http hook missing "url" field' };
  }

  // SEC-08: SSRF tier filter — block requests to internal/private hosts unless
  // the hook definition opts in with allowInternal: true.
  if (!hook.allowInternal) {
    const hostname = extractHostname(url);
    if (hostname !== null) {
      const trustResult = classifyHostTrustTier(hostname);
      if (trustResult.tier === 'blocked') {
        emitSsrfDeny(hostname, url, trustResult.reason);
        return { ok: false, error: `http hook blocked: ${trustResult.reason}` };
      }
    }
  }

  const timeoutMs = (hook.timeout ?? 30) * 1000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...hook.headers,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `http hook received ${response.status} ${response.statusText}`,
      };
    }

    const text = await response.text();
    if (!text.trim()) {
      return { ok: true };
    }

    try {
      const result = JSON.parse(text) as HookResult;
      return { ...result, ok: result.ok ?? true };
    } catch {
      return { ok: true };
    }
  } catch (err) {
    const message = summarizeError(err);
    logger.error('http hook error', { url, error: message });
    return { ok: false, error: message };
  }
}
