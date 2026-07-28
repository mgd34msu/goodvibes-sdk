/**
 * orchestrator-turn-flags.ts — the per-turn feature reads, in one place.
 *
 * These three questions are asked once per turn and answered purely from the
 * flag manager plus one setting. They carried no orchestrator state beyond
 * those two inputs, so keeping them as methods on a 1100-line class made the
 * class longer without making them clearer.
 *
 * They are gathered here rather than scattered because their DEFAULTS differ in
 * a way that is easy to get wrong and matters: two of them default ON when no
 * flag manager is wired, and the third defaults OFF. Side by side, that
 * asymmetry is visible and deliberate; a hundred lines apart it reads like an
 * inconsistency someone will "fix".
 */

/** Reads a feature flag. Null when no flag manager is wired to this runtime. */
export interface TurnFlagSources {
  readonly isEnabled: ((flag: string) => boolean) | null;
  /** The embedder's storage.codeIndexEnabled setting, when it exposes one. */
  readonly isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
}

/**
 * Bind the two sources a runtime holds into the shape the reads above take.
 *
 * `coreServices` is reached lazily and optionally on purpose: only the
 * code-injection question consults it, and these reads run on partially built
 * runtimes, so touching it eagerly would make the other two throw where they
 * previously answered.
 */
export function turnFlagSources(
  flagManager: { isEnabled: (flag: string) => boolean } | null | undefined,
  coreServices: { isCodeInjectionSettingEnabled?: (() => boolean) | undefined } | null | undefined,
): TurnFlagSources {
  return {
    isEnabled: flagManager ? (flag: string) => flagManager.isEnabled(flag) : null,
    isCodeInjectionSettingEnabled: () => coreServices?.isCodeInjectionSettingEnabled?.() ?? true,
  };
}

/**
 * Tool-result reconciliation. Defaults ON with no flag manager: it repairs
 * unresolved tool calls, and a runtime without flags wired should still get the
 * repair rather than silently accumulate dangling calls.
 */
export function isReconciliationEnabled(sources: TurnFlagSources): boolean {
  if (sources.isEnabled === null) return true;
  return sources.isEnabled('tool-result-reconciliation');
}

/**
 * Per-turn passive knowledge injection. Shares the SAME
 * `agent-passive-knowledge-injection` flag as the agent path — one operator
 * feature, one toggle — and follows the same default-ON convention as
 * reconciliation.
 */
export function isPassiveKnowledgeInjectionEnabled(sources: TurnFlagSources): boolean {
  if (sources.isEnabled === null) return true;
  return sources.isEnabled('agent-passive-knowledge-injection');
}

/**
 * Stage B code injection is opt-in, and is the one that defaults OFF: a null
 * flag manager means off here, unlike the two above. Both the
 * `agent-passive-code-injection` flag AND the embedder's
 * storage.codeIndexEnabled setting must be on, and both are re-read per turn.
 */
export function isPassiveCodeInjectionEnabled(sources: TurnFlagSources): boolean {
  const flagOn = sources.isEnabled?.('agent-passive-code-injection') ?? false;
  const settingOn = sources.isCodeInjectionSettingEnabled?.() ?? true;
  return flagOn && settingOn;
}
