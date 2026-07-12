/**
 * localhost-fetch-approval.ts — the one-tap "allow for this project" ask for
 * fetches to loopback dev servers.
 *
 * STANDING RULE (same as sandbox escalations and MCP elicitations): the ask
 * rides the ONE approval broker so every surface's existing approval UI
 * renders it. Approving persists `fetch.allowLocalhost` in the PROJECT
 * settings tier, so the question is asked once per project and never again —
 * including across restarts. Denying refuses this fetch with an honest
 * tool-result reason; a later fetch may ask again.
 *
 * Private-IP and cloud-metadata blocking is untouched by this flow: those
 * targets are refused absolutely, with the reason in the tool result and no
 * ask, notification, or any other user-facing surface.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { ConfigManager } from '../../config/manager.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';

export interface LocalhostFetchApprovalDeps {
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
  readonly configManager: Pick<ConfigManager, 'get' | 'setProjectValue'>;
}

/** Resolves whether a loopback fetch may proceed; see module docs. */
export type LocalhostFetchApproval = (input: { url: string; host: string }) => Promise<boolean>;

export function buildLocalhostFetchApproval(deps: LocalhostFetchApprovalDeps): LocalhostFetchApproval {
  let inFlight: Promise<boolean> | null = null;

  return async (input) => {
    // Already approved for this project (possibly by a concurrent ask).
    if (deps.configManager.get('fetch.allowLocalhost') === true) return true;
    // Single-flight: concurrent URLs in one batch share the ask.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const request: PermissionPromptRequest = {
          callId: `fetch-localhost-${randomUUID().slice(0, 8)}`,
          tool: 'fetch',
          args: { url: input.url, host: input.host },
          category: 'read',
          analysis: {
            classification: 'fetch-localhost',
            riskLevel: 'medium',
            summary: `Fetch a localhost dev server: ${input.url}`,
            reasons: [
              `The fetch tool wants to reach the loopback host "${input.host}" (a local dev server).`,
              'Approving allows localhost fetches for this project and will not ask again (fetch.allowLocalhost).',
              'Private-IP and cloud-metadata targets stay blocked regardless of this approval.',
            ],
            target: input.url,
            targetKind: 'url',
            surface: 'network',
            blastRadius: 'local',
            host: input.host,
          },
          attribution: { kind: 'fetch-localhost', host: input.host, url: input.url },
        };
        const decision = await deps.requestApproval({
          request,
          metadata: { source: 'fetch-localhost', host: input.host, url: input.url },
        });
        if (decision.approved) {
          // The one-tap semantics: approval IS "allow for this project".
          deps.configManager.setProjectValue('fetch.allowLocalhost', true);
          logger.info('[fetch] localhost fetches allowed for this project (fetch.allowLocalhost persisted)', {
            host: input.host,
          });
        }
        return decision.approved;
      } catch (err) {
        logger.warn('[fetch] localhost fetch ask failed; refusing this fetch', {
          host: input.host,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
