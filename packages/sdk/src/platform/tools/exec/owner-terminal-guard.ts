/**
 * owner-terminal-guard.ts, the owner's terminal is not a surface this platform
 * types into.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * Recorded owner doctrine: never touch tmux sessions the platform did not
 * create. This module is that rule made enforceable at the exec layer, for
 * turns that run without anyone watching: a command that INTERACTS with an
 * existing tmux session, window or pane, send-keys, kill, resize, attach,
 * respawn, rename, is refused, and the refusal names the rule.
 *
 * Creating and driving the platform's OWN tmux sessions stays allowed, because
 * that is not the owner's terminal: a session this platform made is a session
 * this platform may type into. Ownership is proved by NAME
 * ({@link PLATFORM_TMUX_SESSION_PREFIX}), plus any names a composition
 * registers, because a name is the only thing a shell command carries that can
 * be checked before the command runs. A pane id (`%3`), a window id (`@2`) or a
 * session id (`$1`) proves nothing about who created it, so a target spelled
 * that way is refused rather than guessed at.
 *
 * Reading is not touching. `list-sessions`, `list-panes`, `capture-pane` and
 * the other observation verbs are allowed: the platform's fleet view already
 * reads the pane list to notice externally-launched agents
 * (runtime/fleet/observed/detect.ts), and refusing to LOOK would break that
 * without protecting anything.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not the frozen catastrophic block, which lives in the classifier, is
 * unconditional, and is untouched by this file. It is not a command-class
 * policy either, class risk stays with the permission settings. It is one
 * named rule about one named tool, applied where a composition asks for it, and
 * it can only ever refuse.
 *
 * It does not reach the platform's own tmux drill-in steer
 * (runtime/fleet/observed/source.ts), which spawns tmux directly rather than
 * through the exec tool and is an affordance the owner drives himself from the
 * fleet view.
 */

import { normalizeCommand } from '../../runtime/permissions/normalization/index.js';
import type { CommandSegment } from '../../runtime/permissions/normalization/types.js';

/**
 * The name prefix that marks a tmux session as the platform's own.
 *
 * A session the platform creates is named `goodvibes-<something>`; a command
 * targeting one is a command about the platform's own workspace, not the
 * owner's terminal.
 */
export const PLATFORM_TMUX_SESSION_PREFIX = 'goodvibes-';

/** Whether the guard is applied to this composition's commands. */
export type OwnerTerminalGuardPosture =
  /** Commands that drive an existing tmux session the platform does not own are refused. */
  | 'enforced'
  /** No guard. The default, so composing this concept changes nothing by itself. */
  | 'off';

/** What a composition states about the owner's terminal. */
export interface OwnerTerminalGuard {
  readonly posture: OwnerTerminalGuardPosture;
  /**
   * Extra tmux session names this composition owns, beyond the
   * {@link PLATFORM_TMUX_SESSION_PREFIX} convention. Exact names, no patterns.
   */
  readonly ownedSessionNames?: readonly string[] | undefined;
}

/** The verdict for one command. */
export interface OwnerTerminalDecision {
  readonly allowed: boolean;
  /** Present when `allowed` is false: the plain refusal, ready to return. */
  readonly refusal?: string | undefined;
}

const ALLOWED: OwnerTerminalDecision = { allowed: true };

/**
 * tmux server flags that consume the NEXT token as their value. Walking past
 * these is what keeps `tmux -L sock send-keys …` from being read as the
 * subcommand `sock`.
 */
const SERVER_FLAGS_WITH_VALUE = new Set(['-c', '-f', '-L', '-S', '-T']);

/**
 * Observation verbs. These read tmux state and change nothing; the platform's
 * own fleet detection already runs `list-panes`.
 */
const OBSERVATION_SUBCOMMANDS = new Set([
  'list-sessions', 'ls',
  'list-panes', 'lsp',
  'list-windows', 'lsw',
  'list-clients', 'lsc',
  'list-buffers', 'lsb',
  'list-commands', 'lscm',
  'list-keys', 'lsk',
  'show-options', 'show',
  'show-window-options', 'showw',
  'show-environment', 'showenv',
  'show-messages', 'showmsgs',
  'has-session', 'has',
  'capture-pane', 'capturep',
  'display-panes-time',
  'server-info',
  'info',
]);

/** Verbs that make a NEW session rather than reaching into an existing one. */
const SESSION_CREATING_SUBCOMMANDS = new Set(['new-session', 'new']);

/**
 * Verbs where `-a` means "everything EXCEPT the target".
 *
 * `tmux kill-session -a -t goodvibes-build` reads as a command about the
 * platform's own session and kills every OTHER session on the server, the
 * owner's included. Inverted targeting cannot be checked by looking at the
 * target, so these are refused whenever `-a` is present.
 */
const INVERTING_SUBCOMMANDS = new Set(['kill-session', 'kill-window', 'killw', 'unlink-window', 'unlinkw']);

/** Strip one layer of surrounding quotes the tokenizer preserved. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  }
  return value;
}

/** The parsed shape of one tmux invocation. */
interface TmuxInvocation {
  /** The verb, or null when the command was a bare `tmux` with no subcommand. */
  readonly subcommand: string | null;
  /**
   * What `-t` named. This is the TARGET in every verb that takes one, including
   * the session `new-session` groups itself with.
   */
  readonly targetFlag: readonly string[];
  /**
   * What `-s` named. A real source target in the swap/move/join verbs, but the
   * NEW session's NAME in `new-session`, which is why the two are kept apart
   * rather than pooled: reading `-s` as a target there would refuse an ordinary
   * `tmux new-session -d -s build`, which creates nothing of the owner's.
   */
  readonly sourceFlag: readonly string[];
  /** True when `-A` was passed (attach-if-exists on `new-session`). */
  readonly attachIfExists: boolean;
  /** True when `-a` was passed (inverted targeting on the kill verbs). */
  readonly allButTarget: boolean;
}

/**
 * Walk a tmux argv into its verb and its targets. Deliberately its own tiny
 * walk rather than a reuse of the normalized `args`/`flags` arrays, which lose
 * the ORDER that says which token a `-t` consumes.
 */
function parseTmuxInvocation(segment: CommandSegment): TmuxInvocation {
  const argv = segment.tokens.slice(1).map((token) => unquote(token.value));
  const targetFlag: string[] = [];
  const sourceFlag: string[] = [];
  let subcommand: string | null = null;
  let attachIfExists = false;
  let allButTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (subcommand === null) {
      if (!token.startsWith('-')) {
        subcommand = token;
        continue;
      }
      if (SERVER_FLAGS_WITH_VALUE.has(token)) index += 1; // its value is not the verb
      continue;
    }
    if (token === '-A') {
      attachIfExists = true;
      continue;
    }
    if (token === '-a') {
      allButTarget = true;
      continue;
    }
    if (token === '-t' || token === '-s') {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        (token === '-t' ? targetFlag : sourceFlag).push(value);
        index += 1;
      }
      continue;
    }
  }

  return { subcommand, targetFlag, sourceFlag, attachIfExists, allButTarget };
}

/**
 * Whether a tmux target names a session this platform owns.
 *
 * The session part is everything before the first `:` (`goodvibes-run:0.1` is
 * the platform's session). An id-shaped target (`%3`, `@2`, `$1`) carries no
 * name to check and is never treated as owned.
 */
function isOwnedTarget(target: string, ownedSessionNames: readonly string[]): boolean {
  const sessionPart = target.split(':')[0] ?? '';
  if (sessionPart === '') return false;
  if (sessionPart.startsWith('%') || sessionPart.startsWith('@') || sessionPart.startsWith('$')) return false;
  if (sessionPart.startsWith(PLATFORM_TMUX_SESSION_PREFIX)) return true;
  return ownedSessionNames.includes(sessionPart);
}

const RULE_LINE =
  'Platform rule: the owner\'s terminal is untouchable, this platform never drives a tmux '
  + 'session, window or pane it did not create.';

function refuse(detail: string): OwnerTerminalDecision {
  return {
    allowed: false,
    refusal:
      `Command refused: ${detail}\n`
      + `${RULE_LINE}\n`
      + `Creating and driving this platform's own sessions (named `
      + `${PLATFORM_TMUX_SESSION_PREFIX}…) is allowed, and so is reading tmux state `
      + '(list-sessions, list-panes, capture-pane). Report what you found and propose '
      + "what you would do, rather than doing it in the owner's shell.",
  };
}

/** Judge one tmux invocation. Returns null when it is fine. */
function judgeTmuxSegment(
  segment: CommandSegment,
  ownedSessionNames: readonly string[],
): OwnerTerminalDecision | null {
  const { subcommand, targetFlag, sourceFlag, attachIfExists, allButTarget } = parseTmuxInvocation(segment);
  const foreign = (names: readonly string[]): string[] =>
    names.filter((name) => !isOwnedTarget(name, ownedSessionNames));

  if (subcommand === null) {
    return refuse(
      '`tmux` with no subcommand attaches to (or creates) the default session on the '
      + 'running server, which is the owner\'s.',
    );
  }
  if (OBSERVATION_SUBCOMMANDS.has(subcommand)) return null;

  if (allButTarget && INVERTING_SUBCOMMANDS.has(subcommand)) {
    return refuse(
      `\`tmux ${subcommand} -a\` acts on everything EXCEPT its target, so it reaches every `
      + 'session on the server whatever the target names.',
    );
  }

  if (SESSION_CREATING_SUBCOMMANDS.has(subcommand)) {
    // A new session is not the owner's terminal. Two ways this verb can still
    // land on an existing one: `-t` groups the new session with an existing
    // one, and `-A` attaches to the `-s` name when that name is already taken.
    // A plain `-s` is just what the new session will be called, and is not
    // checked, refusing `tmux new-session -d -s build` would be refusing a
    // command that touches nothing.
    const reachable = [...foreign(targetFlag), ...(attachIfExists ? foreign(sourceFlag) : [])];
    if (reachable.length === 0) return null;
    return refuse(
      `\`tmux ${subcommand}\` here can land on an existing session `
      + `(${reachable.join(', ')}) rather than making a new one.`,
    );
  }

  const named = [...targetFlag, ...sourceFlag];
  if (named.length === 0) {
    return refuse(
      `\`tmux ${subcommand}\` names no target, so it acts on the tmux server's current `
      + 'session, the owner\'s.',
    );
  }
  const notOurs = foreign(named);
  if (notOurs.length === 0) return null;
  return refuse(
    `\`tmux ${subcommand}\` drives ${notOurs.join(', ')}, which this platform did not create.`,
  );
}

/**
 * Decide whether a command may run under this composition's owner-terminal
 * posture. Pure; never throws.
 *
 * @param command - The raw shell command string, exactly as it would run.
 * @param guard - The composition's posture. `undefined` reads as `off`.
 */
export function decideOwnerTerminalAccess(
  command: string,
  guard: OwnerTerminalGuard | null | undefined,
): OwnerTerminalDecision {
  if (!guard || guard.posture !== 'enforced') return ALLOWED;

  let segments: CommandSegment[];
  try {
    segments = normalizeCommand(command).segments;
  } catch {
    // A command this pipeline cannot parse is not evidence of a tmux call. The
    // frozen catastrophic block and the permission layer still apply to it.
    return ALLOWED;
  }

  for (const segment of segments) {
    if (segment.command !== 'tmux') continue;
    const verdict = judgeTmuxSegment(segment, guard.ownedSessionNames ?? []);
    if (verdict) return verdict;
  }
  return ALLOWED;
}
