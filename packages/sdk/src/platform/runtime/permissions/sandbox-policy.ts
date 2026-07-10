/**
 * sandbox-policy.ts — the sandbox-aware INPUT to the exec permission decision.
 *
 * This is ordinary permission-layer policy, not a new enforcement path: given a
 * command and whether the per-command exec sandbox is active, it decides whether
 * a command that would otherwise prompt ("ask") under prompt mode can auto-allow
 * because it runs entirely inside the OS boundary with no host-access need — or
 * must still surface as an explicit escalation ask that NAMES what it wants
 * (network, host-privilege escalation, a package install that reaches the
 * network). A consumer composes this with its existing decision machinery: when
 * the base policy would ask an exec, it consults this to see whether the sandbox
 * turns that ask into an allow.
 *
 * FROZEN CATASTROPHIC BLOCK IS UNTOUCHED. This module never inspects, relaxes,
 * or re-implements the unconditional catastrophic block (rm -rf /, dd to a
 * device, mkfs, fork bomb …). That block is enforced independently, at exec
 * time, and stays in force identically inside the sandbox — a boundary never
 * buys a catastrophic command an allow. Doctrine: "permission settings are the
 * sole authority for command-class risk; the exec-layer unconditional block is a
 * frozen catastrophic-only list … that must NEVER expand without Mike's explicit
 * approval." This layer only ever RELAXES an ask to an allow for boundary-safe
 * commands; it can never turn a deny into an allow.
 */

import { normalizeCommand } from './normalization/index.js';

export type SandboxPolicyEffect = 'allow' | 'ask';

export interface SandboxPolicyDecision {
  /** The resolved effect for this exec under the sandbox-aware policy. */
  readonly effect: SandboxPolicyEffect;
  /** Whether the command would run inside the boundary. */
  readonly sandboxed: boolean;
  /**
   * Named host-access needs when `effect` is 'ask' because of them (e.g.
   * "wants network"). Empty when the command is boundary-safe and auto-allowed,
   * or when the sandbox is inactive (base policy applies).
   */
  readonly escalations: string[];
  /** Human-readable justification for the decision. */
  readonly reason: string;
}

export interface SandboxPolicyInput {
  readonly command: string;
  /**
   * Whether the sandbox is genuinely active: the graduation-gated feature flag
   * is on, `sandbox.enabled` config is true, AND the host can provide a boundary.
   * When false, the base policy applies unchanged.
   */
  readonly sandboxActive: boolean;
  /** Command base names (or `*`) whose network access is re-enabled in the boundary. */
  readonly egressAllowlist: readonly string[];
  /**
   * What the existing permission layer would decide for this exec absent the
   * sandbox (prompt mode → 'ask'). Returned unchanged when the sandbox is
   * inactive, so this policy is purely additive.
   */
  readonly baseEffectWhenNotSandboxed: SandboxPolicyEffect;
}

/** Package-manager install shapes that reach the network but classify as writes. */
const PACKAGE_INSTALL: ReadonlyArray<{ readonly cmd: string; readonly subs: ReadonlySet<string> }> = [
  { cmd: 'npm', subs: new Set(['install', 'i', 'ci', 'add', 'update']) },
  { cmd: 'pnpm', subs: new Set(['install', 'i', 'add', 'update']) },
  { cmd: 'yarn', subs: new Set(['install', 'add', 'up']) },
  { cmd: 'bun', subs: new Set(['install', 'add']) },
  { cmd: 'pip', subs: new Set(['install']) },
  { cmd: 'pip3', subs: new Set(['install']) },
  { cmd: 'apt', subs: new Set(['install']) },
  { cmd: 'apt-get', subs: new Set(['install']) },
  { cmd: 'brew', subs: new Set(['install']) },
  { cmd: 'cargo', subs: new Set(['install', 'add']) },
  { cmd: 'go', subs: new Set(['install', 'get']) },
];

interface CommandFacts {
  readonly classifications: readonly string[];
  readonly segments: ReadonlyArray<{ command: string; args: string[] }>;
}

function readCommandFacts(command: string): CommandFacts {
  try {
    const normalized = normalizeCommand(command);
    return {
      classifications: normalized.classifications,
      segments: normalized.segments.map((seg) => ({ command: seg.command, args: seg.args })),
    };
  } catch {
    return { classifications: [], segments: [] };
  }
}

function isOnEgressAllowlist(facts: CommandFacts, egressAllowlist: readonly string[]): boolean {
  if (egressAllowlist.includes('*')) return true;
  const bases = new Set(facts.segments.map((s) => s.command));
  return egressAllowlist.some((name) => bases.has(name));
}

function detectsPackageInstall(facts: CommandFacts): boolean {
  return facts.segments.some((seg) => {
    const match = PACKAGE_INSTALL.find((p) => p.cmd === seg.command);
    if (!match) return false;
    return seg.args.some((arg) => match.subs.has(arg));
  });
}

/**
 * Decide, for a single exec, whether the active sandbox turns a base "ask" into
 * an "allow", or whether the command still needs a named escalation ask.
 */
export function decideSandboxedExec(input: SandboxPolicyInput): SandboxPolicyDecision {
  if (!input.sandboxActive) {
    return {
      effect: input.baseEffectWhenNotSandboxed,
      sandboxed: false,
      escalations: [],
      reason: 'sandbox not active; base permission policy applies unchanged',
    };
  }

  const facts = readCommandFacts(input.command);
  const escalations: string[] = [];

  const wantsNetwork = facts.classifications.includes('network');
  if (wantsNetwork) {
    escalations.push(
      isOnEgressAllowlist(facts, input.egressAllowlist)
        ? 'wants network (on egress allowlist — granted inside the boundary once approved)'
        : 'wants network (not on egress allowlist — denied inside the boundary unless approved)',
    );
  } else if (detectsPackageInstall(facts)) {
    escalations.push('wants network (package install)');
  }

  if (facts.classifications.includes('escalation')) {
    escalations.push('wants host privilege escalation');
  }

  if (escalations.length > 0) {
    return {
      effect: 'ask',
      sandboxed: true,
      escalations,
      reason: `runs inside the sandbox boundary but needs host access: ${escalations.join('; ')}`,
    };
  }

  return {
    effect: 'allow',
    sandboxed: true,
    escalations: [],
    reason: 'runs inside the sandbox boundary with no host-access need — auto-allowed',
  };
}
