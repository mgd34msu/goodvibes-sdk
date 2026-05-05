/**
 * Telemetry prompt/response redaction configuration.
 *
 * Privacy model (what actually ships):
 *
 * - RuntimeEventBus carries raw prompt/response strings. In-process
 *   consumers (conversation reducer, channel reply pipeline, stream UI)
 *   require raw content to render and advance state.
 *
 * - TelemetryApiService ring buffer stores raw payloads.
 *
 * - Egress boundary: `listEvents({view: 'safe'})` (the default) runs records
 *   through `sanitizeRecord` → `redactStructuredData` (see
 *   `utils/redaction.ts`). Any string value whose key matches
 *   `CONTENT_KEY_PATTERN` (prompt, response, content, accumulated, reasoning,
 *   body, text, stdout, stderr, output, input, transcript, command,
 *   arguments, query, detail, summary, message) is replaced with
 *   `[REDACTED_TEXT length=N]`. Values carrying specific secret shapes
 *   (API keys, tokens) are pattern-redacted regardless of key.
 *
 * - `listEvents({view: 'raw'})` skips redaction and is gated at the HTTP
 *   boundary on the `admin` or `read:telemetry-sensitive` scope (see
 *   daemon/telemetry-routes.ts).
 *
 * This module owns the `telemetry.includeRawPrompts` config flag. The flag
 * is wired at daemon bootstrap by `facade-composition.ts` via
 * `setTelemetryIncludeRawPrompts(configManager.get('telemetry.includeRawPrompts'))`.
 * Opt-in (true) emits a startup WARN so operators can see the configuration.
 *
 * Known gap: `listEvents({view: 'raw'})` does not yet consult the flag — raw
 * view access is gated by scope only. The flag is available for future
 * hardening (e.g. refuse raw view regardless of scope when the flag is off).
 */
import { logger } from '../../utils/logger.js';

/** Module-scoped flag. Wired once at daemon bootstrap. */
let _includeRawPrompts = false;

/**
 * Configure telemetry redaction behavior. Called once at daemon bootstrap from
 * config.telemetry.includeRawPrompts. When true, a WARN log is emitted so ops
 * can see the opt-in is active.
 */
export function setTelemetryIncludeRawPrompts(value: boolean): void {
  _includeRawPrompts = value;
  if (value) {
    logger.warn(
      'telemetry.includeRawPrompts is ENABLED — raw prompt/response content will appear in telemetry events. '
      + 'This setting is for debugging only. Disable in production to avoid PII/secret exfiltration.'
    );
  }
}

/** Read the current flag. Reserved for future view='raw' gating. */
export function getTelemetryIncludeRawPrompts(): boolean {
  return _includeRawPrompts;
}
