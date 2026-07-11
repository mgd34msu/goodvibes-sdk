/**
 * sandbox-escalation-wiring.ts — compose the sandbox-escalation seam + the
 * optional model-judgment tier at the runtime composition root.
 *
 * Kept out of services.ts so the wiring (broker routing + the dark-flag judgment
 * tier + the provider adapter) lives next to the seam it configures rather than
 * bloating the services monolith. Returns the boolean handler the exec tool's
 * sandbox calls; when the sandbox is inactive the handler is simply never
 * invoked.
 */
import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { ConfigManager } from '../../config/manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import {
  createSandboxEscalationApprovalHandler,
  type SandboxEscalationJudgment,
} from './sandbox-escalation.js';
import { createSandboxJudgmentProvider, type SandboxJudgmentChat } from './sandbox-judgment.js';

/** The boolean escalation handler the exec sandbox invokes per command. */
export type ExecSandboxEscalationHandler = (input: {
  readonly command: string;
  readonly escalations: readonly string[];
  readonly boundary: string;
  readonly policyReasons: readonly string[];
  readonly workingDirectory?: string | undefined;
}) => Promise<boolean>;

/** The broker seam this wiring routes through. */
export interface EscalationWiringDeps {
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly routeId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'>;
}

/**
 * Build the exec-sandbox escalation handler: escalations ride the approval
 * broker, and — only when the `sandbox-model-judgment` flag is on — the judgment
 * tier annotates the ask (default) or auto-approves a looks-safe verdict (opt-in
 * via `sandbox.judgmentAutoApprove`). Every judgment leaves a receipt.
 */
export function buildSandboxEscalationHandler(deps: EscalationWiringDeps): ExecSandboxEscalationHandler {
  const judgment: SandboxEscalationJudgment | undefined = deps.featureFlags.isEnabled('sandbox-model-judgment')
    ? {
        provider: createSandboxJudgmentProvider((async (prompt) => {
          const model = deps.providerRegistry.getCurrentModel();
          const provider = deps.providerRegistry.getForModel(model.registryKey, model.provider);
          const res = await provider.chat({ messages: [{ role: 'user', content: prompt }], model: model.id });
          return res.content ?? '';
        }) satisfies SandboxJudgmentChat),
        config: { enabled: true, autoApprove: deps.configManager.get('sandbox.judgmentAutoApprove') },
        onReceipt: (r) => logger.info('[sandbox-judgment] receipt', {
          command: r.command, verdict: r.verdict, outcome: r.outcome, reasons: r.reasons,
        }),
      }
    : undefined;

  const seam = createSandboxEscalationApprovalHandler(deps.requestApproval, judgment);
  return async (input) => (await seam({ sandbox: 'exec-sandbox', ...input })).approved;
}
