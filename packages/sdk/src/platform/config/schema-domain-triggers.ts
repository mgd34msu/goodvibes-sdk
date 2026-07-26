/**
 * schema-domain-triggers.ts — the trigger family (`watchers.triggers.*`).
 *
 * Three watcher kinds share one supervision spine:
 *   - stream    — regex-filtered, line-batched tail of a long-lived command
 *   - condition — model-free declarative check (probe -> extract -> rule)
 *   - on-exit   — one-shot payload when a supervised child process terminates
 *
 * `watchers.triggers.enabled` ships **false** by design, not as limbo: a
 * trigger starts supervised long-lived processes, so on-by-default would run
 * watchers nobody asked for. Every key below is a real configurable feature
 * with a written purpose, never a bare toggle — the supervision ladder, the
 * breaker, the retention bounds and the process caps are all operator-tunable.
 *
 * Kept in its own domain module so the trigger family can evolve without
 * touching the shared runtime schema file.
 */
import type { ConfigSettingDefinition } from './schema-shared.js';
import { intRange } from './schema-shared.js';

/** Trigger-family configuration (`watchers.triggers.*`). */
export interface TriggersConfig {
  /** Master gate. False by default — a trigger supervises real processes. */
  enabled: boolean;
  /** Comma-separated backoff ladder (ms) walked on consecutive check failures. */
  backoffLadderMs: string;
  /** Consecutive failures that open the breaker and park the trigger. */
  breakerStrikes: number;
  /** Default cadence for condition checks that do not set their own. */
  defaultCheckIntervalMs: number;
  /** Hard ceiling on how long one probe may run before it is abandoned. */
  probeTimeoutMs: number;
  /** Condition checks allowed to run at the same moment. */
  maxConcurrentChecks: number;
  /** Observations retained per trigger — the ring buffer the rules read. */
  observationRingSize: number;
  /** Run-history records retained per trigger. */
  runHistoryLimit: number;
  /** Age ceiling (hours) on retained run history. */
  runHistoryTtlHours: number;
  /** Entries retained in the shared cross-watcher correlation event log. */
  eventLogLimit: number;
  /** Age ceiling (hours) on the shared correlation event log. */
  eventLogTtlHours: number;
  /** Cadence of the recurring recovery sweep (reap + bound + revalidate). */
  sweepIntervalMs: number;
  /** Cadence of the supervision tick that reaps finished children and runs due checks. */
  supervisionTickMs: number;
  /** Lines a stream watcher may hold before it drops the oldest. */
  streamQueueLimit: number;
  /** Matched lines batched into one payload before an agent is invoked. */
  streamBatchLines: number;
  /** Time a partial stream batch waits before it is flushed anyway. */
  streamBatchIntervalMs: number;
  /** Ceiling on a supervised on-exit child before it is terminated `timed-out`. */
  onExitMaxDurationMs: number;
  /** Standard input handed to a supervised on-exit child. */
  onExitStdin: string;
  /** Bytes of tail output carried in a termination payload. */
  outputTailBytes: number;
}

declare module './schema-types.js' {
  interface WatchersConfig {
    triggers: TriggersConfig;
  }
}

export const triggersConfigDefaults: { triggers: TriggersConfig } = {
  triggers: {
    enabled: false,
    backoffLadderMs: '30000,60000,300000,900000,3600000',
    breakerStrikes: 5,
    defaultCheckIntervalMs: 60_000,
    probeTimeoutMs: 15_000,
    maxConcurrentChecks: 4,
    observationRingSize: 200,
    runHistoryLimit: 50,
    runHistoryTtlHours: 168,
    eventLogLimit: 500,
    eventLogTtlHours: 24,
    sweepIntervalMs: 300_000,
    supervisionTickMs: 1_000,
    streamQueueLimit: 1_000,
    streamBatchLines: 25,
    streamBatchIntervalMs: 1_000,
    onExitMaxDurationMs: 21_600_000,
    onExitStdin: 'none',
    outputTailBytes: 8_192,
  },
};

export const triggersConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'watchers.triggers.enabled',
    type: 'boolean',
    default: false,
    description:
      'Enable the trigger family: stream watchers over long-lived commands, model-free condition checks, and one-shot on-exit process triggers. Off by default because a trigger launches and supervises real processes on your machine without a person watching — turning it on is a deliberate choice, not a fallback. With it on and no triggers defined, the supervisor idles and consumes nothing.',
  },
  {
    key: 'watchers.triggers.backoffLadderMs',
    type: 'string',
    default: '30000,60000,300000,900000,3600000',
    description:
      'Comma-separated retry ladder in milliseconds, walked one rung per consecutive failure of a trigger check. The default climbs 30s, 60s, 5m, 15m, 60m so a briefly unreachable endpoint recovers fast while a genuinely broken one stops hammering. The last rung repeats until the breaker opens.',
    validate: (value) => typeof value === 'string'
      && value.split(',').length > 0
      && value.split(',').every((part) => {
        const parsed = Number(part.trim());
        return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 24 * 60 * 60 * 1000;
      }),
    validationHint: 'comma-separated integers, each 1000..86400000 ms',
  },
  {
    key: 'watchers.triggers.breakerStrikes',
    type: 'number',
    default: 5,
    description:
      'Consecutive check failures that open the trigger\'s breaker. An open breaker parks the trigger in a visible circuit-open state with the last error attached instead of retrying forever; the operator resets it explicitly. Raise it for a flaky-but-recoverable source, lower it to fail fast.',
    ...intRange(1, 50),
  },
  {
    key: 'watchers.triggers.defaultCheckIntervalMs',
    type: 'number',
    default: 60_000,
    description:
      'Cadence used by a condition trigger that does not declare its own interval. This is the steady-state polling rate; the backoff ladder overrides it while a trigger is failing.',
    ...intRange(1_000, 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.triggers.probeTimeoutMs',
    type: 'number',
    default: 15_000,
    description:
      'Ceiling on one probe execution (http request, file read, command run, or sdk-tool call) before it is abandoned and counted as a failed check. Keeps a hung endpoint from stalling the whole check queue.',
    ...intRange(250, 10 * 60 * 1000),
  },
  {
    key: 'watchers.triggers.maxConcurrentChecks',
    type: 'number',
    default: 4,
    description:
      'How many condition checks may execute at the same moment. Checks beyond this wait their turn, so a large trigger set cannot saturate the machine or a rate-limited API.',
    ...intRange(1, 64),
  },
  {
    key: 'watchers.triggers.observationRingSize',
    type: 'number',
    default: 200,
    description:
      'Observations kept per trigger in its persisted ring buffer. Every rule — change, transition, rate-of-change, windowed aggregation — is a pure function over this buffer, so this is the memory depth available to them. Larger windows need a larger ring.',
    ...intRange(2, 10_000),
  },
  {
    key: 'watchers.triggers.runHistoryLimit',
    type: 'number',
    default: 50,
    description:
      'Run records kept per trigger (when it ran, what it observed, whether it fired, what the action returned). Bounded on purpose: an append-only history is a disk leak with a nicer name.',
    ...intRange(1, 5_000),
  },
  {
    key: 'watchers.triggers.runHistoryTtlHours',
    type: 'number',
    default: 168,
    description:
      'Age ceiling in hours on retained run history. Records older than this are reaped by the recovery sweep even when the count limit has not been reached, and the sweep reports how many it removed.',
    ...intRange(1, 24 * 365),
  },
  {
    key: 'watchers.triggers.eventLogLimit',
    type: 'number',
    default: 500,
    description:
      'Entries retained in the shared event log that cross-watcher correlation rules read. This log is the only channel through which one trigger can observe another, and it is bounded so correlation cannot grow without limit.',
    ...intRange(10, 50_000),
  },
  {
    key: 'watchers.triggers.eventLogTtlHours',
    type: 'number',
    default: 24,
    description:
      'Age ceiling in hours on the shared correlation event log. Correlation windows longer than this cannot see the older side of the pair, so raise it together with any long correlation window.',
    ...intRange(1, 24 * 90),
  },
  {
    key: 'watchers.triggers.sweepIntervalMs',
    type: 'number',
    default: 300_000,
    description:
      'Cadence of the recurring housekeeping sweep: reap records whose owning process or session is gone, retire fired one-shot triggers, enforce the count and age bounds, and re-validate persisted state by content. A daemon that only sweeps at boot never sweeps.',
    ...intRange(10_000, 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.triggers.supervisionTickMs',
    type: 'number',
    default: 1_000,
    description:
      'How often the supervisor checks whether a supervised on-exit child has terminated and whether any condition check is due. This is the floor on how quickly an on-exit trigger notices its process ended; raise it to trade detection latency for less polling on a machine running long builds.',
    ...intRange(250, 5 * 60 * 1000),
  },
  {
    key: 'watchers.triggers.streamQueueLimit',
    type: 'number',
    default: 1_000,
    description:
      'Matched lines a stream watcher may hold before the oldest are dropped. The queue is bounded so a chatty log cannot exhaust memory; every drop is counted and reported on the trigger record rather than being silent.',
    ...intRange(1, 1_000_000),
  },
  {
    key: 'watchers.triggers.streamBatchLines',
    type: 'number',
    default: 25,
    description:
      'Matched lines gathered into one payload before an agent is invoked. Batching is what keeps a stream watcher from starting one agent turn per log line.',
    ...intRange(1, 10_000),
  },
  {
    key: 'watchers.triggers.streamBatchIntervalMs',
    type: 'number',
    default: 1_000,
    description:
      'How long a partially filled stream batch waits before it is flushed anyway, so a slow trickle of matches still reaches an agent promptly instead of waiting for the batch to fill.',
    ...intRange(50, 60 * 60 * 1000),
  },
  {
    key: 'watchers.triggers.onExitMaxDurationMs',
    type: 'number',
    default: 21_600_000,
    description:
      'Hard ceiling on a supervised on-exit child. When it is reached the child is terminated and the trigger fires with an explicit timed-out termination state, so a process waiting on a prompt that will never come cannot hang forever. The six-hour default is sized for a long build.',
    ...intRange(1_000, 7 * 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.triggers.onExitStdin',
    type: 'enum',
    default: 'none',
    enumValues: ['none', 'empty'],
    description:
      'Standard input handed to a supervised on-exit child. "none" closes stdin so a password-prompting process gets EOF and exits instead of blocking forever; "empty" attaches an immediately-closed empty pipe for programs that require a readable stdin handle. There is deliberately no interactive option — nobody is at the keyboard.',
  },
  {
    key: 'watchers.triggers.outputTailBytes',
    type: 'number',
    default: 8_192,
    description:
      'Bytes of trailing child output carried in an on-exit termination payload. Exit is not success, so the payload always includes this tail for the agent prompt to inspect alongside the exit code and signal.',
    ...intRange(0, 1_048_576),
  },
];
