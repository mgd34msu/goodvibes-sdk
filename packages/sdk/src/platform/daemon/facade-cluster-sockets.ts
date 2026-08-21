/**
 * facade-cluster-sockets.ts, contesting a socket surface under its REAL name.
 *
 * Slack and Discord are the awkward pair. An ntfy topic and a Telegram bot id
 * are in the configuration, so a node knows what it is contesting before it
 * contacts anything. A Slack workspace and a Discord application are not: the
 * config holds a token, and the workspace that token belongs to is a fact only
 * the provider can tell you.
 *
 * The tempting shortcut is a fixed placeholder, every node contesting
 * "the Slack surface". That is a starvation bug, not a conservatism. Two nodes
 * configured for two DIFFERENT workspaces would contest one election, one of
 * them would lose, and its workspace would go unanswered with nothing anywhere
 * to say why. That silence is precisely what per-surface elections exist to
 * eliminate, so it cannot be reintroduced by the naming.
 *
 * So the identity is resolved first, and it is resolved WITHOUT consuming
 * anything: Slack's `auth.test` and Discord's `/users/@me` are authenticated
 * REST calls that open no socket and deliver no events. The surface is
 * therefore contested under its true name from the first datagram, and there
 * is never a window in which this node is reading a workspace it has not won.
 *
 * Two failure shapes are handled here, both of which end in the same place,
 * this node stops contesting a surface it cannot serve:
 *
 *   - The identity does not resolve (no token, a revoked token, the provider
 *     unreachable). Nothing is registered, so this node cannot win it, and the
 *     reason is stated at ERROR rather than left to be inferred from silence.
 *
 *   - The identity resolved, the surface was won, and then the socket dropped.
 *     The gate is withdrawn, which runs the ordinary ordered stand-down: the
 *     consumer stops, a RESIGN goes out, and another machine can take the
 *     workspace immediately instead of waiting out the crash timeout.
 *
 * Both retry, because neither is necessarily permanent, a provider outage
 * ends, a network comes back, and a node that gave up permanently on a
 * transient failure would leave a surface unread the moment the last other
 * node went away.
 *
 * Retrying forever is not the same as complaining forever. A workspace whose
 * token was revoked and never replaced is a permanent condition, and a fixed
 * retry timer that restates the same ERROR every minute buries the log it is
 * trying to make legible, the same failure the activity logger has already
 * been taught not to commit. So two things are separated here:
 *
 *   - The RETRY interval backs off, base delay doubling up to a ceiling, with
 *     equal jitter so a group of nodes that all lost the same provider do not
 *     re-ask it in lockstep.
 *
 *   - The ERROR is stated ONCE per unbroken run of failures. Later attempts in
 *     the same run go to debug with the attempt count, and the run is closed
 *     out by an info line when the identity finally resolves, so the operator
 *     sees both the onset and the recovery, and nothing in between.
 *
 * A socket that drops is deliberately NOT put behind the same backoff: the
 * first attempt after a lost socket is prompt, because a reconnect usually
 * succeeds immediately. If the provider really is down, that prompt attempt
 * fails to resolve the identity and the identity backoff takes over from
 * there, which is the escalation the situation actually calls for.
 */
import { providerSurface, type ClusterSurfaceKey } from '../cluster/index.js';

/** Base delay before a node that could not identify a surface tries again. */
const DEFAULT_RETRY_MS = 60_000;
/**
 * The ceiling the backoff climbs to. Long enough that a permanently broken
 * token costs almost nothing, short enough that a surface left unread comes
 * back within a coffee break of the provider recovering.
 */
const DEFAULT_MAX_RETRY_MS = 15 * 60_000;

export interface SocketSurfaceSupervisorOptions {
  readonly kind: 'slack' | 'discord';
  /**
   * The provider's own name for what this token reads, a Slack team id, a
   * Discord application id, or null when that cannot be established.
   */
  readonly resolveIdentity: () => Promise<string | null>;
  /** Register the gate for a surface; returns the withdraw function. */
  readonly register: (surface: ClusterSurfaceKey) => () => void;
  /** False once the daemon is shutting down, so retries stop. */
  readonly isRunning: () => boolean;
  readonly reportInert: (surface: string, action: string) => void;
  readonly logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
  /** Injected so tests need no real timers. Returns its own cancel function. */
  readonly setTimer?: ((fn: () => void, ms: number) => () => void) | undefined;
  /** Base retry delay; the first retry of a failure run waits about this long. */
  readonly retryMs?: number | undefined;
  /** Ceiling the backoff climbs to. */
  readonly maxRetryMs?: number | undefined;
  /** Jitter source in [0, 1). Injected so a test can pin the delay exactly. */
  readonly random?: (() => number) | undefined;
}

const MISSING_IDENTITY_ACTION: Record<'slack' | 'discord', string> = {
  slack: 'the Slack workspace could not be identified, so this node will not contest it; '
    + 'check surfaces.slack.botToken (a goodvibes://secrets/... reference is fine) or the '
    + 'SLACK_BOT_TOKEN environment variable, and that the workspace is reachable',
  discord: 'the Discord application could not be identified, so this node will not contest it; '
    + 'check surfaces.discord.botToken (a goodvibes://secrets/... reference is fine) or the '
    + 'DISCORD_BOT_TOKEN environment variable, and that Discord is reachable',
};

export class SocketSurfaceSupervisor {
  private withdraw: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private identity: string | null = null;
  private disposed = false;
  /** Identity lookups that have failed in a row; 0 once one succeeds. */
  private identityFailures = 0;
  /** True once the current run of failures has been stated at ERROR. */
  private reportedInert = false;

  constructor(private readonly options: SocketSurfaceSupervisorOptions) {}

  /** The surface this node is currently contesting, or null. */
  get contestedSurface(): ClusterSurfaceKey | null {
    return this.identity === null ? null : providerSurface(this.options.kind, this.identity);
  }

  /**
   * Resolve the identity and, if it is real, contest that surface.
   *
   * Safe to call repeatedly: an already-registered surface is left alone
   * rather than registered twice.
   */
  async begin(): Promise<void> {
    if (this.disposed || !this.options.isRunning()) return;
    if (this.withdraw) return;
    const identity = await this.options.resolveIdentity();
    if (this.disposed || !this.options.isRunning()) return;
    if (!identity) {
      this.identity = null;
      this.identityFailures += 1;
      const retryMs = this.nextRetryMs();
      if (!this.reportedInert) {
        // First failure of this run: the operator needs the action, at ERROR.
        this.reportedInert = true;
        this.options.reportInert(this.options.kind, MISSING_IDENTITY_ACTION[this.options.kind]);
      } else {
        // Still the same failure. Restating it at ERROR every retry would bury
        // the one line that mattered, so the repeats are debug-level detail.
        this.options.logger.debug('cluster: a socket surface still cannot be identified', {
          surface: this.options.kind,
          attempts: this.identityFailures,
          retryMs,
        });
      }
      this.scheduleRetry(retryMs);
      return;
    }
    if (this.reportedInert) {
      // Close out the ERROR: an operator who saw the onset gets to see it end,
      // rather than being left to infer recovery from the absence of a repeat.
      this.options.logger.info('cluster: a socket surface that could not be identified now can be', {
        surface: this.options.kind,
        attempts: this.identityFailures,
      });
    }
    this.identityFailures = 0;
    this.reportedInert = false;
    this.identity = identity;
    const surface = providerSurface(this.options.kind, identity);
    this.withdraw = this.options.register(surface);
    // The identity itself is not logged: a workspace id names the customer's
    // organisation. It reaches the network only as a digest, and it reaches
    // this log only as one.
    this.options.logger.info('cluster: contesting a socket surface under its own identity', {
      surface: this.options.kind,
    });
  }

  /**
   * The socket dropped. Stand down from the surface and try to get it back.
   *
   * Withdrawing runs the ordered stand-down inside the registry, the consumer
   * is stopped and only then is the RESIGN broadcast, so the successor never
   * starts against a consumer that is still running.
   */
  onSocketLost(reason: string): void {
    if (this.disposed) return;
    if (!this.withdraw) return;
    this.withdraw();
    this.withdraw = null;
    this.options.logger.info('cluster: standing down from a socket surface this node can no longer read', {
      surface: this.options.kind,
      reason,
    });
    this.scheduleRetry();
  }

  /** Stop retrying and withdraw. Called when the daemon shuts down. */
  dispose(): void {
    this.disposed = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.withdraw?.();
    this.withdraw = null;
  }

  /**
   * The delay for the next identity attempt: the base doubling per consecutive
   * failure up to the ceiling, then equal jitter so that a group of nodes which
   * all lost the same provider do not come back at it in one wave.
   */
  private nextRetryMs(): number {
    const base = this.options.retryMs ?? DEFAULT_RETRY_MS;
    const ceiling = Math.max(base, this.options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS);
    // Cap the exponent before it is used, so a long outage cannot overflow it.
    const steps = Math.min(Math.max(this.identityFailures - 1, 0), 30);
    const target = Math.min(base * 2 ** steps, ceiling);
    const random = this.options.random ?? Math.random;
    // Equal jitter: never less than half the target, never more than it.
    return Math.round(target / 2 + random() * (target / 2));
  }

  /**
   * @param retryMs Delay to use. Omitted after a lost socket, which retries at
   *   the base delay: a reconnect usually works at once, and if the provider is
   *   genuinely down the identity lookup will fail and start the backoff itself.
   */
  private scheduleRetry(retryMs?: number): void {
    this.cancelRetry?.();
    const delay = retryMs ?? this.options.retryMs ?? DEFAULT_RETRY_MS;
    const schedule = this.options.setTimer ?? defaultTimer;
    this.cancelRetry = schedule(() => {
      this.cancelRetry = null;
      void this.begin();
    }, delay);
    this.options.logger.debug('cluster: will try to identify a socket surface again', {
      surface: this.options.kind,
      retryMs: delay,
    });
  }
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  // Never hold the process open just to retry an identity lookup.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => { clearTimeout(handle); };
}
