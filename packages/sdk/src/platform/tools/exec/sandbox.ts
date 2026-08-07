/**
 * sandbox.ts — per-command OS-level execution boundary for the exec tool,
 * backed by bubblewrap (`bwrap`) on Linux.
 *
 * GOAL. Shrink the approval tail: a command that runs inside a real OS boundary
 * — workspace writable, the rest of the filesystem read-only, /tmp isolated,
 * network off unless explicitly allowed — is far less able to do harm outside
 * that boundary, so the permission layer can auto-allow it (see
 * runtime/permissions/sandbox-policy.ts) instead of prompting. This module is
 * the RUNNER half: honest availability detection, pure bwrap-argv construction,
 * and a per-command plan. It composes with the existing credential-env scrub
 * (credential-env.ts) rather than replacing it — the scrubbed env is what bwrap
 * hands to the child.
 *
 * HONESTY. Detection never claims a boundary it cannot deliver. No bwrap (or a
 * non-Linux host) → the feature reports unavailable with a stated reason and the
 * caller runs the byte-for-byte-unchanged non-sandboxed exec path. When bwrap is
 * present but a host-level probe cannot confirm that `--unshare-net` yields a
 * real, empty network namespace (e.g. unprivileged user namespaces disabled),
 * the plan says network isolation is `unknown` rather than claiming containment.
 *
 * NOT a permission decision and NOT the frozen catastrophic block. The
 * unconditional catastrophic block (rm -rf /, dd to a device, mkfs, fork bomb …)
 * is enforced elsewhere and stays in force identically INSIDE the sandbox — a
 * boundary is not a licence for a catastrophic command.
 */

import { spawnSync } from 'node:child_process';
import { normalizeCommand } from '../../runtime/permissions/normalization/index.js';
import { decideSandboxedExec } from '../../runtime/permissions/sandbox-policy.js';
import { DEFAULT_CONTROL_PLANE_PORT } from '../../config/control-plane-base-url.js';
import type { ExecCommandResult } from './schema.js';

/** Operator-facing per-command exec sandbox configuration (`sandbox.*`). */
export interface ExecSandboxConfig {
  /** Master switch. Default false — the sandbox is off unless explicitly enabled. */
  readonly enabled: boolean;
  /**
   * Command base names (e.g. `curl`, `git`, or `*` for all) whose network access
   * is re-enabled inside the boundary as a NAMED escalation. Empty → the sandbox
   * disables network for every command.
   */
  readonly egressAllowlist: readonly string[];
  /**
   * Absolute paths outside the workspace that are bound writable into the
   * boundary as a NAMED escalation. Empty → only the workspace (and an isolated
   * /tmp) is writable.
   */
  readonly workspaceWritable: readonly string[];
}

/** The honest, host-probed availability of the exec sandbox backend. */
export interface SandboxAvailability {
  readonly available: boolean;
  readonly backend: 'bubblewrap' | 'none';
  /** Resolved `bwrap` path when available. */
  readonly bwrapPath?: string | undefined;
  /** Stated reason — a diagnosis when unavailable, a one-line summary when available. */
  readonly reason: string;
  /**
   * Whether a `--unshare-net` boundary is trustworthy on THIS host. False when
   * bwrap is present but a trivial net-unshare probe did not succeed (so a
   * "network disabled" claim would be unproven) — surfaced as `network: 'unknown'`.
   */
  readonly networkIsolationGuaranteed: boolean;
}

/**
 * The raw host-probe inputs detection reasons over. Kept as plain data so
 * {@link detectSandboxAvailability} is pure and unit-testable; production wires
 * the real probe in {@link probeSandboxHost}.
 */
export interface SandboxHostProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** Resolved `bwrap` path, or null when not on PATH. */
  readonly bwrapPath: string | null;
  /** A trivial `bwrap --ro-bind / / /bin/true`-style run exited 0. */
  readonly bwrapWorks: boolean;
  /** A trivial `bwrap --unshare-net --ro-bind / / /bin/true`-style run exited 0. */
  readonly netUnshareWorks: boolean;
}

/**
 * Decide availability from a host probe. Pure. macOS and any non-Linux host are
 * reported unavailable this release (bubblewrap is Linux-only and no
 * sandbox-exec equivalent is wired) — never faked.
 */
export function detectSandboxAvailability(probe: SandboxHostProbe): SandboxAvailability {
  if (probe.platform !== 'linux') {
    return {
      available: false,
      backend: 'none',
      reason:
        `per-command exec sandbox unavailable: bubblewrap is Linux-only and no sandbox-exec ` +
        `equivalent is wired this release (host platform: ${probe.platform})`,
      networkIsolationGuaranteed: false,
    };
  }
  if (!probe.bwrapPath) {
    return {
      available: false,
      backend: 'none',
      reason: 'per-command exec sandbox unavailable: bubblewrap (bwrap) was not found on PATH',
      networkIsolationGuaranteed: false,
    };
  }
  if (!probe.bwrapWorks) {
    return {
      available: false,
      backend: 'none',
      bwrapPath: probe.bwrapPath,
      reason:
        `per-command exec sandbox unavailable: bubblewrap is installed (${probe.bwrapPath}) but a ` +
        `trivial sandbox probe failed — unprivileged user namespaces are likely disabled on this host`,
      networkIsolationGuaranteed: false,
    };
  }
  return {
    available: true,
    backend: 'bubblewrap',
    bwrapPath: probe.bwrapPath,
    reason: probe.netUnshareWorks
      ? `bubblewrap sandbox available (${probe.bwrapPath}); network isolation confirmed`
      : `bubblewrap sandbox available (${probe.bwrapPath}); network isolation NOT confirmed on this host`,
    networkIsolationGuaranteed: probe.netUnshareWorks,
  };
}

/** Pure inputs for {@link buildBwrapArgv}. */
export interface BwrapArgvInput {
  readonly bwrapPath: string;
  /** Absolute workspace path, bound read-write. */
  readonly workspaceDir: string;
  /** Absolute working directory for the child (chdir'd into the boundary). */
  readonly cwd: string;
  /** Extra absolute paths bound read-write. */
  readonly writableExtras: readonly string[];
  /** When true, the child keeps host network; when false, `--unshare-net`. */
  readonly networkEnabled: boolean;
  /** When set, the home directory is masked with a tmpfs (hidden, not just read-only). */
  readonly maskHomeDir?: string | undefined;
}

/**
 * Construct the bwrap argument vector to PREPEND to `['/bin/sh','-c',cmd]`. Pure.
 *
 * The system root is bound read-only, /tmp and (optionally) $HOME are masked with
 * fresh tmpfs, then the workspace and any writable extras are bound read-write
 * LAST so they win over the read-only root even when nested under it. Network is
 * unshared unless explicitly enabled. The env is NOT set here — the caller hands
 * bwrap the already-credential-scrubbed environment, which bwrap passes through.
 */
export function buildBwrapArgv(input: BwrapArgvInput): string[] {
  const argv: string[] = [input.bwrapPath];
  // Read-only view of the whole host filesystem …
  argv.push('--ro-bind', '/', '/');
  argv.push('--dev', '/dev');
  argv.push('--proc', '/proc');
  // … isolated /tmp …
  argv.push('--tmpfs', '/tmp');
  // … optionally mask $HOME so its contents are hidden, not merely read-only …
  if (input.maskHomeDir) {
    argv.push('--tmpfs', input.maskHomeDir);
  }
  // … then carve the writable workspace + extras back in (bound LAST so they win).
  argv.push('--bind', input.workspaceDir, input.workspaceDir);
  for (const extra of input.writableExtras) {
    argv.push('--bind', extra, extra);
  }
  if (!input.networkEnabled) {
    argv.push('--unshare-net');
  }
  argv.push('--unshare-pid');
  argv.push('--unshare-uts');
  argv.push('--unshare-ipc');
  argv.push('--die-with-parent');
  argv.push('--new-session');
  argv.push('--chdir', input.cwd);
  argv.push('--');
  return argv;
}

/** Where the boundary sits on network access for a given command. */
export type SandboxNetworkState = 'disabled' | 'enabled' | 'unknown';

/** The resolved per-command plan the exec runtime acts on. */
export interface ExecSandboxPlan {
  /** True when the command will actually run inside a bwrap boundary. */
  readonly sandboxed: boolean;
  /** argv to prepend to `['/bin/sh','-c',cmd]`; empty when not sandboxed. */
  readonly argvPrefix: string[];
  /** One-line human summary of the boundary (or why there is none). */
  readonly boundary: string;
  /** Network posture for this command inside the boundary. */
  readonly network: SandboxNetworkState;
  /** Named host-access grants applied to this run (network, writable extras). */
  readonly escalationsGranted: string[];
  /**
   * Whether $HOME was masked with a tmpfs for this run. Recorded so the context
   * note claims the mask only when it actually applied — a note that overstates
   * the boundary is the same defect as one that hides it.
   *
   * Optional so adding it does not break a consumer that builds a plan itself;
   * absent is read as "not masked", which is the claim-nothing default.
   */
  readonly homeMasked?: boolean | undefined;
  /** Present when the sandbox was requested but the host cannot provide it. */
  readonly unavailableReason?: string | undefined;
}

/** Inputs to {@link resolveExecSandboxPlan}. */
export interface ResolveSandboxPlanInput {
  readonly config: ExecSandboxConfig;
  readonly availability: SandboxAvailability;
  /** Whether the exec-sandbox capability gate is on (sandbox.enabled). */
  readonly featureEnabled: boolean;
  readonly command: string;
  readonly workspaceDir: string;
  readonly cwd: string;
  readonly homeDir?: string | undefined;
}

/** The base command names of a shell command (for egress-allowlist matching). */
function commandBaseNames(command: string): string[] {
  try {
    const normalized = normalizeCommand(command);
    return normalized.segments.map((seg) => seg.command).filter((c) => c.length > 0);
  } catch {
    return [];
  }
}

/** Whether any of the command's base names is on the egress allowlist (or `*`). */
function egressAllowed(command: string, egressAllowlist: readonly string[]): boolean {
  if (egressAllowlist.includes('*')) return true;
  const bases = new Set(commandBaseNames(command));
  return egressAllowlist.some((name) => bases.has(name));
}

const NOT_SANDBOXED_ARGV: string[] = [];

/**
 * Resolve the per-command sandbox plan. When the capability gate is off, the config
 * switch is off, or the host cannot provide a boundary, returns a not-sandboxed
 * plan (the caller then runs today's unchanged exec path). Otherwise returns the
 * bwrap argv prefix plus honest boundary/network/escalation metadata.
 */
export function resolveExecSandboxPlan(input: ResolveSandboxPlanInput): ExecSandboxPlan {
  if (!input.featureEnabled || !input.config.enabled) {
    return {
      sandboxed: false,
      argvPrefix: NOT_SANDBOXED_ARGV,
      boundary: 'no sandbox: per-command exec sandbox is not enabled',
      network: 'enabled',
      escalationsGranted: [],
      homeMasked: false,
    };
  }
  if (!input.availability.available || !input.availability.bwrapPath) {
    return {
      sandboxed: false,
      argvPrefix: NOT_SANDBOXED_ARGV,
      boundary: `no sandbox: ${input.availability.reason}`,
      network: 'enabled',
      escalationsGranted: [],
      homeMasked: false,
      unavailableReason: input.availability.reason,
    };
  }

  const classifications = (() => {
    try {
      return normalizeCommand(input.command).classifications;
    } catch {
      return [] as ReturnType<typeof normalizeCommand>['classifications'];
    }
  })();
  const wantsNetwork = classifications.includes('network');
  const networkEnabled = wantsNetwork && egressAllowed(input.command, input.config.egressAllowlist);

  const escalationsGranted: string[] = [];
  if (networkEnabled) {
    escalationsGranted.push('network (command on egress allowlist)');
  }
  for (const extra of input.config.workspaceWritable) {
    escalationsGranted.push(`writable path outside workspace: ${extra}`);
  }

  const network: SandboxNetworkState = networkEnabled
    ? 'enabled'
    : input.availability.networkIsolationGuaranteed
      ? 'disabled'
      : 'unknown';

  const argvPrefix = buildBwrapArgv({
    bwrapPath: input.availability.bwrapPath,
    workspaceDir: input.workspaceDir,
    cwd: input.cwd,
    writableExtras: input.config.workspaceWritable,
    networkEnabled,
    ...(input.homeDir ? { maskHomeDir: input.homeDir } : {}),
  });

  const networkSummary =
    network === 'enabled' ? 'network allowed' : network === 'disabled' ? 'network disabled' : 'network isolation unconfirmed';
  const boundary =
    `bubblewrap: workspace ${input.workspaceDir} writable, system read-only, /tmp isolated, ${networkSummary}`;

  return { sandboxed: true, argvPrefix, boundary, network, escalationsGranted, homeMasked: input.homeDir !== undefined };
}

/**
 * The resolved sandbox context the exec runtime threads per call: the config,
 * the host availability, and whether the graduation-gated flag is on. Null on a
 * createExecTool with no sandbox wiring — then every command runs the unchanged
 * non-sandboxed path.
 */
export interface ExecSandboxRuntime {
  readonly config: ExecSandboxConfig;
  readonly availability: SandboxAvailability;
  readonly featureEnabled: boolean;
  readonly homeDir?: string | undefined;
  /**
   * Broker a sandbox host-access escalation ask (network, host-privilege
   * escalation) through the approval broker before the command runs. Wired at
   * the composition root to the sandbox-escalation seam. Returns true when
   * approved. When absent, escalations are not asked (today's behavior); the
   * frozen catastrophic block is enforced independently regardless.
   */
  /**
   * Invoked each time a command actually runs inside the boundary. Wired at
   * the composition root to the announce-once containment receipt ("commands
   * now run contained; escalations will ask") — the announcer keeps the
   * once-semantics, this seam just reports the runs.
   */
  readonly onSandboxedRun?: (() => void) | undefined;
  readonly requestEscalation?: ((input: {
    readonly command: string;
    readonly escalations: readonly string[];
    readonly boundary: string;
    readonly policyReasons: readonly string[];
    readonly workingDirectory?: string | undefined;
  }) => Promise<boolean>) | undefined;
}

/**
 * Resolve the per-command plan from a threaded runtime context. Returns null
 * when there is no sandbox wiring at all, so the caller can skip both the argv
 * wrapping and the result metadata entirely (byte-for-byte today's behavior).
 */
export function resolveRuntimeSandboxPlan(
  sandbox: ExecSandboxRuntime | null,
  command: string,
  workspaceDir: string,
  cwd: string,
): ExecSandboxPlan | null {
  if (!sandbox) return null;
  return resolveExecSandboxPlan({
    config: sandbox.config,
    availability: sandbox.availability,
    featureEnabled: sandbox.featureEnabled,
    command,
    workspaceDir,
    cwd,
    ...(sandbox.homeDir ? { homeDir: sandbox.homeDir } : {}),
  });
}

/**
 * Broker a sandbox host-access escalation ask through the injected
 * `requestEscalation` seam BEFORE the command runs. Returns the named
 * escalations when the ask was DENIED (the caller then denies the command), or
 * null when there was nothing to ask or the ask was approved. The frozen
 * catastrophic block is enforced independently (guardExecCommand) and is
 * untouched here — this only ever gates the host-access escalation, never the
 * command class.
 */
export async function brokerSandboxEscalation(
  sandbox: ExecSandboxRuntime | null,
  plan: ExecSandboxPlan | null,
  command: string,
  workingDirectory: string,
): Promise<{ deniedEscalations: string[] } | null> {
  if (!plan?.sandboxed) return null;
  // A null return means this command WILL run inside the boundary — report it
  // so the wired announcer can turn the first contained run into the one-time
  // "commands now run contained; escalations will ask" line.
  const reportContainedRun = (): null => {
    sandbox?.onSandboxedRun?.();
    return null;
  };
  if (!sandbox?.requestEscalation) return reportContainedRun();
  const decision = decideSandboxedExec({
    command,
    sandboxActive: true,
    egressAllowlist: sandbox.config.egressAllowlist,
    baseEffectWhenNotSandboxed: 'ask',
  });
  if (decision.effect !== 'ask' || decision.escalations.length === 0) return reportContainedRun();
  const approved = await sandbox.requestEscalation({
    command,
    escalations: decision.escalations,
    boundary: plan.boundary,
    policyReasons: [decision.reason],
    workingDirectory,
  });
  return approved ? reportContainedRun() : { deniedEscalations: decision.escalations };
}

/**
 * Build the standing one-line context note for a run inside the boundary.
 *
 * The note exists because the boundary's world differs from the host's in ways
 * that look identical to fact when you only see the output: a fresh network
 * namespace whose `127.0.0.1` is its own, not the host's; a read-only
 * filesystem outside the workspace; a masked /tmp and $HOME; and narrower
 * device and process visibility. A probe that found no Bluetooth adapter and no
 * daemon on `127.0.0.1:3421` was read as the user's machine lacking both.
 *
 * Naming the isolation is only half of it. A model told the daemon is
 * unreachable and nothing else will keep reaching for it — a second curl, then
 * systemctl, then a port check — because the note ruled out the route it had
 * without naming another. So the note names the tools that DO answer the
 * question from outside the boundary, `goodvibes_context` and
 * `goodvibes_settings`, which is what turns a dead end into a next step.
 *
 * It names the isolation, the way through it, and the one action that changes
 * it, and stops. It is not a lecture and it is not repeated per line — one
 * field, once per result.
 */
export function buildSandboxNote(plan: ExecSandboxPlan): string {
  if (!plan.sandboxed) {
    return `not sandboxed: ${plan.unavailableReason ?? 'no boundary applied'} — this ran directly on the host.`;
  }
  const parts: string[] = ['sandboxed: this ran inside a boundary, not on the host'];
  if (plan.network === 'enabled') {
    parts.push('host network shared (localhost services reachable)');
  } else if (plan.network === 'unknown') {
    parts.push(
      'network isolation requested but unconfirmed on this host, so localhost reachability here is not something to reason from',
    );
  } else {
    parts.push(
      `separate network namespace, so host localhost services are unreachable from here — the goodvibes daemon on 127.0.0.1:${DEFAULT_CONTROL_PLANE_PORT} refuses connections inside the boundary even while it is running on the host, so read daemon and settings state with the built-in goodvibes_context tool (mode "summary" for runtime and daemon state, "config_get" for a setting) and change settings with the built-in goodvibes_settings tool, both of which run outside this boundary, rather than retrying curl or systemctl in here (add the command to sandbox.egressAllowlist to share the host network instead)`,
    );
  }
  parts.push(
    `filesystem read-only outside the workspace, /tmp isolated${plan.homeMasked ? ' and $HOME masked' : ''}, credential-bearing environment variables removed, and partial device and process visibility`,
  );
  parts.push(
    'absence observed here is not absence on the host — re-check on the host before concluding something is missing',
  );
  return `${parts.join('; ')}.`;
}

/**
 * Attach sandbox metadata to an exec result. Stays quiet (returns the result
 * unchanged) when there is no plan, or when the sandbox is off entirely and the
 * command simply ran unsandboxed — metadata appears only when the sandbox was
 * active OR was requested-but-unavailable (the honest-unavailable receipt).
 */
export function attachSandboxMeta(result: ExecCommandResult, plan: ExecSandboxPlan | null): ExecCommandResult {
  if (!plan) return result;
  if (!plan.sandboxed && !plan.unavailableReason) return result;
  return {
    ...result,
    sandboxed: plan.sandboxed,
    sandbox_boundary: plan.boundary,
    sandbox_note: buildSandboxNote(plan),
    ...(plan.sandboxed ? { sandbox_network: plan.network } : {}),
    ...(plan.escalationsGranted.length > 0 ? { sandbox_escalations: plan.escalationsGranted } : {}),
  };
}

/**
 * Probe the real host for bubblewrap availability. Impure (spawns `bwrap`
 * trivially, bounded to a short timeout); the pure {@link detectSandboxAvailability}
 * turns the result into an {@link SandboxAvailability}. Non-Linux short-circuits
 * without spawning. This is the wiring production uses; unit tests exercise
 * detection with fabricated probes instead of spawning.
 */
export function probeSandboxHost(): SandboxHostProbe {
  const platform = process.platform;
  if (platform !== 'linux') {
    return { platform, bwrapPath: null, bwrapWorks: false, netUnshareWorks: false };
  }
  const resolved = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8', timeout: 5000 });
  const bwrapPath = resolved.status === 0 ? resolved.stdout.trim() || null : null;
  if (!bwrapPath) {
    return { platform, bwrapPath: null, bwrapWorks: false, netUnshareWorks: false };
  }
  const base = ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev'];
  const trivial = spawnSync(bwrapPath, [...base, '/bin/true'], { timeout: 5000 });
  const bwrapWorks = trivial.status === 0;
  const net = spawnSync(bwrapPath, [...base, '--unshare-net', '/bin/true'], { timeout: 5000 });
  const netUnshareWorks = net.status === 0;
  return { platform, bwrapPath, bwrapWorks, netUnshareWorks };
}
