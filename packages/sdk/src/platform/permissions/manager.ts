import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.js';
import type { PermissionAction, PermissionsToolConfig, PermissionMode, BackgroundAgentsMode } from '../config/schema.js';
import type { PermissionAttribution, PermissionRequestHandler } from './prompt.js';
import { analyzePermissionRequest } from './analysis.js';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.js';
import { LayeredPolicyEvaluator } from '../runtime/permissions/evaluator.js';
import type { PermissionDecision as LayeredPermissionDecision } from '../runtime/permissions/types.js';
import {
  SHIPPED_CREDENTIAL_READ_RULES,
  matchesShippedCredentialReadPath,
} from './credential-read-defaults.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import type { ConfigManager } from '../config/manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  PermissionCategory,
  PermissionCheckResult,
  PermissionDecisionReasonCode,
  PermissionDecisionSource,
} from './types.js';
export type { PermissionMode } from '../config/schema.js';
export type {
  PermissionCategory,
  PermissionRiskLevel,
  PermissionDecisionSource,
  PermissionDecisionReasonCode,
  PermissionRequestAnalysis,
  PermissionCheckResult,
} from './types.js';

type PermissionConfigSnapshot = ReturnType<typeof getConfigSnapshot>;

export interface PermissionConfigReader {
  isAutoApproveEnabled(): boolean;
  getSnapshot(): PermissionConfigSnapshot;
  getWorkingDirectory(): string | null;
}

export function createPermissionConfigReader(
  configManager: Pick<ConfigManager, 'get' | 'getRaw' | 'getWorkingDirectory'>,
): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => isAutoApproveEnabled(configManager),
    getSnapshot: () => getConfigSnapshot(configManager),
    getWorkingDirectory: () => configManager.getWorkingDirectory(),
  };
}

/** Maps tool names to permission categories and config tool keys. */
const TOOL_CATEGORIES: Record<string, PermissionCategory> = {
  read: 'read',
  find: 'read',
  fetch: 'read',
  analyze: 'read',
  inspect: 'read',
  state: 'read',
  registry: 'read',
  goodvibes_context: 'read',
  repo_map: 'read',
  // write — new tool names
  write: 'write',
  edit: 'write',
  goodvibes_settings: 'write',
  // execute — new tool name
  exec: 'execute',
  // delegate — new tool names
  agent: 'delegate',
  delegate: 'delegate',
  workflow: 'delegate',
  mcp: 'delegate',
};

/** Maps tool names to their key in PermissionsToolConfig. */
const TOOL_CONFIG_KEYS: Record<string, keyof PermissionsToolConfig> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  exec: 'exec',
  find: 'find',
  fetch: 'fetch',
  analyze: 'analyze',
  inspect: 'inspect',
  agent: 'agent',
  state: 'state',
  workflow: 'workflow',
  registry: 'registry',
  goodvibes_context: 'state',
  goodvibes_settings: 'write',
  delegate: 'delegate',
  mcp: 'mcp',
};

/**
 * PermissionManager - Controls tool execution approval.
 *
 * Approval logic (priority order):
 *   1. --no-worries-just-vibes flag OR mode='allow-all' -> auto-approve everything
 *   2. mode='custom' -> check per-tool config action ('allow'/'prompt'/'deny')
 *   3. mode='prompt' (default) -> auto-approve reads, prompt for writes/execute/delegate
 *   4. Session approval cache hit -> use cached decision
 *   5. Ask the shell-owned permission controller and block until user responds
 */
export class PermissionManager {
  private sessionApprovals = new Map<string, boolean>();
  private readonly requestPermission: PermissionRequestHandler;
  private readonly configReader: PermissionConfigReader;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;

  constructor(
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    configReader: PermissionConfigReader,
    policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
    featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null = null,
  ) {
    this.requestPermission = requestPermission;
    this.configReader = configReader;
    this.policyRuntimeState = policyRuntimeState;
    this.hookDispatcher = hookDispatcher;
    this.featureFlags = featureFlags;
  }

  /**
   * check - Returns a Promise that resolves to true (approved) or false (denied).
   * Blocks orchestrator until the user responds when a prompt is needed.
   */
  async check(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution): Promise<boolean> {
    const result = await this.checkDetailed(toolName, args, attribution);
    return result.approved;
  }

  /**
   * @param attribution When present, rides on the brokered ask so a surface can
   * render which background agent is asking. Only reaches the ask path
   * (prompt/session-cache-miss); auto-approve/deny short-circuits ignore it.
   */
  async checkDetailed(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution): Promise<PermissionCheckResult> {
    // 1. Auto-approve when --no-worries-just-vibes is active
    const category = this.getCategory(toolName, args);
    const analysis = analyzePermissionRequest(toolName, args, category);
    const callId = crypto.randomUUID();
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', {
      callId,
      toolName,
      category,
      analysis,
    });
    this.policyRuntimeState.recordPermissionRequest({
      callId,
      tool: toolName,
      category,
      analysis,
    });
    if (this.configReader.isAutoApproveEnabled()) {
      return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'config_policy', 'config_allow', analysis));
    }

    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';

    // 2. allow-all mode ("auto"): auto-approve everything
    if (mode === 'allow-all') {
      return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis));
    }

    // 2a. plan mode: read-only tools allowed; every mutating/exec/delegate tool
    // is refused with a structured plan-mode denial (reasonCode 'plan_mode'),
    // which the tool-runtime turns into a ToolDenial with reason 'plan-mode'
    // that steers the model toward presenting a plan.
    if (mode === 'plan') {
      if (category === 'read') {
        return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis));
      }
      return this.emitAndReturn(callId, toolName, category, this.result(false, false, 'runtime_mode', 'plan_mode', analysis));
    }

    // 2b. accept-edits mode: file write/edit tools auto-approve; reads
    // auto-approve; exec and every other risky class fall through to the
    // prompt/cache path so they still ask.
    if (mode === 'accept-edits') {
      if (category === 'read' && !this.isGatedCredentialRead(category, args)) {
        return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis));
      }
      if (category === 'write') {
        return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'runtime_mode', 'mode_accept_edits', analysis));
      }
      // execute / delegate: fall through to session cache + prompt below.
    }

    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const evaluatorDecision = this.evaluateRuntimePolicy(toolName, args, mode);
      const mappedDecision = this.mapEvaluatorDecision(evaluatorDecision, analysis);
      if (mappedDecision) {
        return this.emitAndReturn(callId, toolName, category, mappedDecision);
      }
    }

    // 3. custom mode: check per-tool setting
    if (mode === 'custom') {
      if (TOOL_CONFIG_KEYS[toolName] !== undefined) {
        const toolKey = TOOL_CONFIG_KEYS[toolName]!;
        const action: PermissionAction = permsConfig?.tools?.[toolKey] ?? 'prompt';
        if (action === 'allow') return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'config_policy', 'config_allow', analysis));
        if (action === 'deny') return this.emitAndReturn(callId, toolName, category, this.result(false, false, 'config_policy', 'config_deny', analysis));
        // action === 'prompt': fall through to cache + prompt
      } else {
        // Unknown tool in custom mode: default to 'prompt' behavior
        // Fall through to cache + prompt
      }
    } else {
      // 4. prompt mode: auto-approve read operations — EXCEPT reads of a
      // well-known credential store, which fall through to the ask/prompt path
      // (a shipped default the user can override by approving once).
      if (category === 'read' && !this.isGatedCredentialRead(category, args)) {
        return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'config_policy', 'config_allow', analysis));
      }
    }

    // 5. Check session approval cache
    const key = this.getApprovalKey(toolName, args);
    if (this.sessionApprovals.has(key)) {
      const approved = this.sessionApprovals.get(key)!;
      return this.emitAndReturn(callId, toolName, category, this.result(
        approved,
        true,
        'session_override',
        approved ? 'session_cached_allow' : 'session_cached_deny',
        analysis,
      ));
    }

    // 6. Prompt user via the shell-owned permission controller
    let decision: Awaited<ReturnType<PermissionRequestHandler>>;
    try {
      decision = await this.requestPermission({
        callId,
        tool: toolName,
        args,
        category,
        analysis,
        workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
        ...(attribution ? { attribution } : {}),
      });
    } catch (error) {
      void this.fireHook('Fail:permission:request', 'Fail', 'permission', 'request', {
        callId,
        toolName,
        category,
        analysis,
        error: summarizeError(error),
      });
      throw error;
    }
    if (decision.remember) {
      this.sessionApprovals.set(key, decision.approved);
    }
    return this.emitAndReturn(callId, toolName, category, this.result(
      decision.approved,
      Boolean(decision.remember),
      'user_prompt',
      decision.approved ? 'user_approved' : 'user_denied',
      analysis,
      decision.modifiedArgs,
    ));
  }

  /**
   * previewReadAccess — non-interactive answer to "would a `read` of `path` be
   * auto-allowed right now, WITHOUT prompting?" Returns 'allow' when it would be
   * auto-allowed and 'restricted' otherwise (a would-prompt/ask path or an
   * outright deny). Search / list / map tools call this per candidate file so
   * their results never surface CONTENT the read tool itself would gate behind
   * an ask/deny (e.g. the shipped credential-read defaults).
   *
   * It runs the SAME layered decision as {@link checkDetailed} up to the ask
   * boundary — the same mode logic, the same isGatedCredentialRead check (→
   * matchesShippedCredentialReadPath), and the same policy evaluator + mapping —
   * so it can never drift from a parallel path matcher. It never prompts, caches,
   * records, or fires hooks; it is a pure read of current config + rules.
   */
  previewReadAccess(rawPath: string): 'allow' | 'restricted' {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return 'allow';
    const category: PermissionCategory = 'read';
    const args: Record<string, unknown> = { path: rawPath };

    if (this.configReader.isAutoApproveEnabled()) return 'allow';

    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';

    if (mode === 'allow-all') return 'allow';
    if (mode === 'plan') return 'allow'; // reads are permitted in plan mode
    if (mode === 'accept-edits') {
      return this.isGatedCredentialRead(category, args) ? 'restricted' : 'allow';
    }

    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const analysis = analyzePermissionRequest('read', args, category);
      const mapped = this.mapEvaluatorDecision(this.evaluateRuntimePolicy('read', args, mode), analysis);
      if (mapped) return mapped.approved ? 'allow' : 'restricted';
    }

    if (mode === 'custom') {
      const toolKey = TOOL_CONFIG_KEYS['read'];
      if (toolKey !== undefined) {
        const action = permsConfig?.tools?.[toolKey] ?? 'prompt';
        if (action === 'allow') return 'allow';
        if (action === 'deny') return 'restricted';
      }
      // No per-tool allow: a read would prompt, which a mid-search filter cannot
      // do — treat as restricted so no unvetted content is surfaced.
      return 'restricted';
    }

    // prompt mode ("normal"): reads auto-allow EXCEPT gated credential stores,
    // which fall through to the ask path and are therefore restricted here.
    return this.isGatedCredentialRead(category, args) ? 'restricted' : 'allow';
  }

  /**
   * getMode — Returns the active session permission mode from config.
   * Surfaces (mode pill) and the orchestrator's standing plan-mode instruction
   * read this to reflect the current mode. Defaults to 'prompt' ("normal").
   */
  getMode(): PermissionMode {
    return this.configReader.getSnapshot().permissions?.mode ?? 'prompt';
  }

  /**
   * getBackgroundAgentsMode — how background/subagent tool calls consult this
   * manager. 'inherit' (default): apply the session mode exactly like foreground.
   * 'allow-all': background agents are exempt (auto-approve). Read by the agent
   * runner before it gates a background tool call.
   */
  getBackgroundAgentsMode(): BackgroundAgentsMode {
    return this.configReader.getSnapshot().permissions?.backgroundAgents ?? 'inherit';
  }

  /** Returns the permission category for a tool name. Unknown tools default to 'delegate'. */
  getCategory(toolName: string, args: Record<string, unknown> = {}): PermissionCategory {
    if (toolName === 'inspect' && args.mode === 'scaffold' && args.dryRun === false) {
      return 'write';
    }
    return TOOL_CATEGORIES[toolName] ?? 'delegate';
  }

  /**
   * getApprovalKey - Stable key for session-level "always approve" decisions.
   * Includes the most meaningful argument to distinguish different invocations.
   */
  private getApprovalKey(toolName: string, args: Record<string, unknown>): string {
    if (typeof args['path'] === 'string') {
      return `${toolName}:${args['path']}`;
    }
    if (typeof args['command'] === 'string') {
      return `${toolName}:${args['command']}`;
    }
    // Generic key: tool name only ("always allow this tool").
    return toolName;
  }

  private result(
    approved: boolean,
    persisted: boolean,
    sourceLayer: PermissionDecisionSource,
    reasonCode: PermissionDecisionReasonCode,
    analysis: ReturnType<typeof analyzePermissionRequest>,
    modifiedArgs?: Record<string, unknown>,
  ): PermissionCheckResult {
    return {
      approved,
      persisted,
      sourceLayer,
      reasonCode,
      analysis,
      modifiedArgs,
    };
  }

  /**
   * A read whose path names a well-known credential store, which the shipped
   * default protects: it must not be SILENTLY auto-allowed. Returns false for
   * non-read categories and for paths that do not match a credential store. A
   * user can still override by approving (session cache), switching to allow-all,
   * or adding a user allow-rule.
   */
  private isGatedCredentialRead(
    category: PermissionCategory,
    args: Record<string, unknown>,
  ): boolean {
    if (category !== 'read') return false;
    const rawPath =
      typeof args['path'] === 'string' ? args['path']
      : typeof args['file_path'] === 'string' ? args['file_path']
      : typeof args['file'] === 'string' ? args['file']
      : typeof args['target'] === 'string' ? args['target']
      : null;
    if (rawPath === null) return false;
    return matchesShippedCredentialReadPath(rawPath, {
      projectRoot: this.configReader.getWorkingDirectory() ?? undefined,
    }).matched;
  }

  private evaluateRuntimePolicy(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionConfigSnapshot['permissions']['mode'],
  ): LayeredPermissionDecision {
    // Shipped managed credential-read deny rules are appended AFTER the
    // registry's rules. User-origin rules are evaluated before managed rules by
    // the evaluator, so a user allow-rule still wins over these defaults.
    const rules = [
      ...(this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? []),
      ...SHIPPED_CREDENTIAL_READ_RULES,
    ];
    const evaluator = new LayeredPolicyEvaluator({
      mode:
        mode === 'allow-all' ? 'allow-all'
        : mode === 'custom' ? 'custom'
        : mode === 'plan' ? 'plan'
        : mode === 'accept-edits' ? 'accept-edits'
        : 'default',
      projectRoot: this.configReader.getWorkingDirectory() ?? undefined,
      rules,
      defaultEffect: 'deny',
    });
    return evaluator.evaluate(toolName, args);
  }

  private mapEvaluatorDecision(
    decision: LayeredPermissionDecision,
    analysis: ReturnType<typeof analyzePermissionRequest>,
  ): PermissionCheckResult | null {
    if (decision.allowed) {
      if (decision.sourceLayer === 'policy') {
        return this.result(true, false, 'managed_policy', 'managed_policy_allow', analysis);
      }
      if (decision.sourceLayer === 'safety') {
        return this.result(false, false, 'safety_check', 'safety_guardrail', analysis);
      }
      if (decision.sourceLayer === 'mode') {
        return this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis);
      }
      if (decision.sourceLayer === 'default' && decision.classification === 'read') {
        return this.result(true, false, 'config_policy', 'config_allow', analysis);
      }
      return null;
    }

    if (decision.sourceLayer === 'safety') {
      return this.result(false, false, 'safety_check', 'safety_guardrail', analysis);
    }
    if (decision.sourceLayer === 'mode') {
      return this.result(false, false, 'runtime_mode', 'mode_denied', analysis);
    }
    if (decision.sourceLayer === 'policy') {
      return this.result(false, false, 'managed_policy', 'managed_policy_deny', analysis);
    }

    return null;
  }

  private emitAndReturn(
    callId: string,
    toolName: string,
    category: PermissionCategory,
    result: PermissionCheckResult,
  ): PermissionCheckResult {
    this.policyRuntimeState.recordPermissionDecision({
      callId,
      tool: toolName,
      category,
      result,
    });
    void this.fireHook('Post:permission:decision', 'Post', 'permission', 'decision', {
      callId,
      toolName,
      category,
      approved: result.approved,
      persisted: result.persisted,
      sourceLayer: result.sourceLayer,
      reasonCode: result.reasonCode,
      riskLevel: result.analysis.riskLevel,
      classification: result.analysis.classification,
    });
    return result;
  }

  private async fireHook(
    path: HookEventPath,
    phase: HookPhase,
    category: HookCategory,
    specific: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await this.hookDispatcher.fire({
        path,
        phase,
        category,
        specific,
        sessionId: 'permissions',
        timestamp: Date.now(),
        payload,
      });
    } catch (error) {
      // Permission hooks are observability-only. Dispatch failures are logged
      // but do not alter permission decisions or prompt flow.
      logger.warn('PermissionManager: permission hook dispatch failed', {
        path,
        callId: typeof payload['callId'] === 'string' ? payload['callId'] : undefined,
        error: summarizeError(error),
      });
    }
  }
}
