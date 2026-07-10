/**
 * graduation.ts — feature-flag graduation as a release policy.
 *
 * The platform ships most feature flags default-OFF ("dark") and flips them on
 * only once they are validated. Nothing forced a per-release DECISION about the
 * flags that had earned their way on — so validated work could sit dark
 * indefinitely. This module is the lightweight bookkeeping that forces that
 * decision: every flag carries an owner-facing graduation state, and the
 * release gate FAILS if any flag sits in `graduate-candidate` — a flag judged
 * ready but neither flipped on nor given a dated reason it is being held.
 *
 * It is bookkeeping, NOT a new simulation system. Evidence is wired in from the
 * machinery that already exists (the permissions divergence simulator); a flag
 * with no instrumentation honestly reports "no evidence collected" and is never
 * given a fabricated readiness.
 */
import { FEATURE_FLAGS } from './flags.js';
import type { FeatureFlag, FlagState } from './types.js';

/**
 * The graduation lane a flag sits in.
 * - `graduated`         — the flag's default flipped ON (it graduated).
 * - `dark`              — default OFF, no graduation evidence gathered.
 * - `soaking`           — default OFF, an owner has it accumulating evidence.
 * - `graduate-candidate`— judged ready to flip, awaiting a release decision.
 *   THIS is the only release-blocking state: it must resolve to `graduated`
 *   (flip it) or `blocked` (record a dated reason) every release.
 * - `blocked`           — held OFF on purpose, with a dated recorded reason.
 */
export type GraduationState = 'dark' | 'soaking' | 'graduate-candidate' | 'graduated' | 'blocked';

/** The validation instrumentation a flag actually has wired (a static fact). */
export type GraduationInstrumentation = 'divergence-simulation' | 'none';

/** A dated reason a ready flag is being held OFF rather than flipped. */
export interface GraduationBlocker {
  readonly reason: string;
  /** ISO date (YYYY-MM-DD) the blocker was recorded. */
  readonly date: string;
}

/**
 * An owner-set annotation that overrides a flag's DERIVED graduation state.
 * A flag with no annotation derives to `graduated` (default ON) or `dark`
 * (default OFF). Only the soaking / candidate / blocked lanes are owner-set.
 */
export interface FlagGraduationAnnotation {
  readonly flagId: string;
  readonly state: 'soaking' | 'graduate-candidate' | 'blocked';
  /** Required when state === 'blocked'; forbidden otherwise. */
  readonly blocker?: GraduationBlocker;
  /** Free-form owner note (evidence pointer, rationale). */
  readonly note?: string;
}

/** Real shadow/divergence readings for a flag, when a live provider supplies them. */
export interface FlagDivergenceEvidence {
  readonly divergenceRate: number;
  readonly totalEvaluations: number;
  readonly gateStatus: 'allowed' | 'blocked' | 'no_data';
}

/** The evidence bundle for one flag — real data, or an explicit absence of it. */
export interface FlagGraduationEvidence {
  readonly instrumentation: GraduationInstrumentation;
  /** Divergence readings when a live provider supplied them; null otherwise. */
  readonly divergence: FlagDivergenceEvidence | null;
  /** Human-readable summary; says "no evidence collected" when nothing real exists. */
  readonly note: string;
}

/** A resolved graduation row for one flag. */
export interface FlagGraduationEntry {
  readonly flagId: string;
  readonly name: string;
  readonly tier: number;
  readonly currentDefault: FlagState;
  readonly runtimeToggleable: boolean;
  readonly state: GraduationState;
  readonly evidence: FlagGraduationEvidence;
  readonly blocker: GraduationBlocker | null;
  readonly note: string | null;
}

export interface FlagGraduationSummary {
  readonly total: number;
  readonly dark: number;
  readonly soaking: number;
  readonly graduateCandidate: number;
  readonly graduated: number;
  readonly blocked: number;
}

export interface FlagGraduationReport {
  readonly generatedAt: number;
  readonly entries: readonly FlagGraduationEntry[];
  readonly summary: FlagGraduationSummary;
  /**
   * Flag ids that block a release: every flag in `graduate-candidate` (ready,
   * but neither flipped nor blocked). Empty means the release policy passes.
   */
  readonly releaseBlockers: readonly string[];
}

/** Provides real shadow/divergence readings for a flag, or null when none exist. */
export interface GraduationEvidenceProvider {
  divergenceFor(flagId: string): FlagDivergenceEvidence | null;
}

/**
 * Which flags have real validation instrumentation wired today. Only the
 * permissions simulation pair carries the shadow/divergence machinery; every
 * other flag has `none` and reports "no evidence collected" — never a
 * fabricated readiness. Extend this map as instrumentation is added.
 */
const FLAG_INSTRUMENTATION: Readonly<Record<string, GraduationInstrumentation>> = {
  'permissions-simulation': 'divergence-simulation',
  'permission-divergence-dashboard': 'divergence-simulation',
};

/**
 * Owner-set graduation annotations. HONEST DEFAULT: empty — no flag is asserted
 * ready without recorded evidence. Owners add soaking/candidate/blocked entries
 * here as real evidence arrives; the release gate then forces each candidate to
 * flip or record a dated blocker.
 */
export const FLAG_GRADUATION_ANNOTATIONS: readonly FlagGraduationAnnotation[] = [];

function instrumentationFor(flagId: string): GraduationInstrumentation {
  return FLAG_INSTRUMENTATION[flagId] ?? 'none';
}

/** Derive the graduation state from the flag default and any owner annotation. */
function deriveState(flag: FeatureFlag, annotation: FlagGraduationAnnotation | undefined): GraduationState {
  // A flipped-on default IS graduation — it wins over any stale annotation.
  if (flag.defaultState === 'enabled') return 'graduated';
  if (!annotation) return 'dark';
  return annotation.state;
}

function buildEvidence(
  flag: FeatureFlag,
  provider: GraduationEvidenceProvider | null,
): FlagGraduationEvidence {
  const instrumentation = instrumentationFor(flag.id);
  if (instrumentation === 'none') {
    return { instrumentation, divergence: null, note: 'no evidence collected (no instrumentation)' };
  }
  const divergence = provider?.divergenceFor(flag.id) ?? null;
  if (!divergence) {
    return {
      instrumentation,
      divergence: null,
      note: 'instrumentation available (permissions divergence simulation); no evidence collected this run',
    };
  }
  return {
    instrumentation,
    divergence,
    note:
      `divergence rate ${divergence.divergenceRate} over ${divergence.totalEvaluations} evaluations; ` +
      `enforce gate ${divergence.gateStatus}`,
  };
}

/** Validate an annotation, throwing on a contradictory or unknown entry. */
function validateAnnotation(annotation: FlagGraduationAnnotation, known: ReadonlySet<string>): void {
  if (!known.has(annotation.flagId)) {
    throw new Error(`[flag-graduation] annotation references unknown flag "${annotation.flagId}"`);
  }
  if (annotation.state === 'blocked' && !annotation.blocker) {
    throw new Error(`[flag-graduation] flag "${annotation.flagId}" is blocked but records no dated blocker`);
  }
  if (annotation.state !== 'blocked' && annotation.blocker) {
    throw new Error(`[flag-graduation] flag "${annotation.flagId}" carries a blocker but is not in the blocked state`);
  }
}

export interface BuildFlagGraduationReportOptions {
  readonly flags?: readonly FeatureFlag[];
  readonly annotations?: readonly FlagGraduationAnnotation[];
  readonly evidence?: GraduationEvidenceProvider | null;
  readonly now?: () => number;
}

/**
 * Build the graduation report from the flag registry, owner annotations, and
 * whatever real evidence a provider supplies. Pure and deterministic given its
 * inputs; supplies live defaults so the operator verb and CLI can call it bare.
 */
export function buildFlagGraduationReport(options: BuildFlagGraduationReportOptions = {}): FlagGraduationReport {
  const flags = options.flags ?? FEATURE_FLAGS;
  const annotations = options.annotations ?? FLAG_GRADUATION_ANNOTATIONS;
  const provider = options.evidence ?? null;
  const now = options.now ?? Date.now;

  const known = new Set(flags.map((f) => f.id));
  const byId = new Map<string, FlagGraduationAnnotation>();
  for (const annotation of annotations) {
    validateAnnotation(annotation, known);
    byId.set(annotation.flagId, annotation);
  }

  const entries: FlagGraduationEntry[] = flags.map((flag) => {
    const annotation = byId.get(flag.id);
    const state = deriveState(flag, annotation);
    return {
      flagId: flag.id,
      name: flag.name,
      tier: flag.tier,
      currentDefault: flag.defaultState,
      runtimeToggleable: flag.runtimeToggleable,
      state,
      evidence: buildEvidence(flag, provider),
      blocker: annotation?.blocker ?? null,
      note: annotation?.note ?? null,
    };
  });

  const summary: FlagGraduationSummary = {
    total: entries.length,
    dark: entries.filter((e) => e.state === 'dark').length,
    soaking: entries.filter((e) => e.state === 'soaking').length,
    graduateCandidate: entries.filter((e) => e.state === 'graduate-candidate').length,
    graduated: entries.filter((e) => e.state === 'graduated').length,
    blocked: entries.filter((e) => e.state === 'blocked').length,
  };

  const releaseBlockers = entries.filter((e) => e.state === 'graduate-candidate').map((e) => e.flagId);

  return { generatedAt: now(), entries, summary, releaseBlockers };
}

export interface GraduationReleaseGateResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly message: string;
}

/**
 * The release policy: a report passes only when nothing sits in
 * `graduate-candidate`. Each candidate must flip (become `graduated`) or record
 * a dated blocker (become `blocked`) before the release proceeds.
 */
export function evaluateGraduationReleaseGate(report: FlagGraduationReport): GraduationReleaseGateResult {
  const blockers = report.releaseBlockers;
  if (blockers.length === 0) {
    return { ok: true, blockers, message: 'flag graduation: no flags awaiting a release decision' };
  }
  return {
    ok: false,
    blockers,
    message:
      `flag graduation: ${blockers.length} flag(s) in graduate-candidate must flip on or record a dated blocker ` +
      `before release: ${blockers.join(', ')}`,
  };
}
