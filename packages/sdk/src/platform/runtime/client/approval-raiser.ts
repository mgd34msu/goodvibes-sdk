/**
 * approval-raiser.ts — how a permission ask leaves a surface that is a client.
 *
 * ── What changed ───────────────────────────────────────────────────────────
 *
 * A surface product used to construct its OWN `ApprovalBroker`, and every ask
 * went into it: raised in-process, prompted at that surface, decided there,
 * stored there. When the surface also hosted the daemon that was coherent. Once
 * the daemon is a separate process it is not — an ask raised there was invisible
 * to every other surface, to the daemon's attention machinery, and to the phone
 * that was supposed to be able to answer it.
 *
 * So the ask goes to the daemon (`approvals.raise`) AND prompts locally, and the
 * first real answer wins. The daemon owns the record; the surface is one
 * participant that happens to be sitting in front of the user.
 *
 * ── The shape, precisely ───────────────────────────────────────────────────
 *
 * 1. Raise the ask on the daemon. The verb returns the pending record
 *    immediately — it deliberately does not park an HTTP request across a
 *    person's attention span.
 * 2. Prompt locally at the same time.
 * 3. Watch the raised id for a decision made elsewhere. The channel for that is
 *    `control.approval_update`, which carries every transition of the record the
 *    moment the broker records it — so a decision made on a phone reaches this
 *    surface in the time one SSE frame takes, not in the time one poll interval
 *    takes. A product wires the stream in through `subscribeApprovalUpdates`.
 *
 *    Polling `approvals.list` remains as the FALLBACK, and it is a real one, not
 *    a formality: a client with no stream seam wired, or one whose stream the
 *    daemon refused, still gets its answer. There is also one read immediately
 *    after subscribing, because a decision can land between the raise and the
 *    subscription and a push channel cannot deliver what happened before it
 *    opened.
 * 4. Whichever answers first is the decision. If the local prompt answered, the
 *    daemon is TOLD (`approvals.approve`/`approvals.deny`) so its record — the
 *    one every other surface reads — matches what happened here.
 *
 * ── When the daemon is not reachable ───────────────────────────────────────
 *
 * The ask is prompted locally and answered locally, and that is the honest
 * outcome: a user in front of a surface can still approve their own tool call
 * with no daemon running. Nothing is silently swallowed and nothing pretends a
 * remote record exists. The refusal reason is logged once per process so a
 * misconfigured control plane is visible without a line per ask.
 *
 * ── The local prompt is not cancelled ──────────────────────────────────────
 *
 * A remote decision resolves the ask; the prompt this surface already drew stays
 * on screen until the user dismisses it, and its answer is ignored (the decision
 * has been taken). This mirrors what the in-process broker did with a
 * `localPrompt` racing a wire decision — there is no cancel channel into a drawn
 * prompt, and inventing one is a renderer change, not a client-seam change.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import type { ApprovalRaiser } from '../permissions/permission-composition.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from './approval-updates.js';

/**
 * How this surface opens the approval-update stream. A product supplies it
 * because resolving a base URL and proving this surface may subscribe are
 * trust-boundary concerns the SDK core deliberately never reaches into — the
 * same carve-out `DaemonVerbCaller` records.
 *
 * Returning null means "no stream right now", which is a supported answer:
 * the raiser falls back to reading the record on an interval.
 */
export type ApprovalUpdateSubscriber = (
  onUpdate: (notice: ApprovalUpdateNotice) => void,
) => Promise<ApprovalUpdateSubscription | null>;

/** The local ask: draw a prompt on this surface and resolve with what the user chose. */
export type LocalPermissionPrompt = (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>;

/** How often the raised id is re-read while the local prompt is open. */
const DEFAULT_POLL_INTERVAL_MS = 750;

export interface ClientApprovalRaiserOptions {
  readonly verbs: DaemonVerbCaller;
  /** The prompt this surface draws. Late-bound: the UI layer patches it in after boot. */
  readonly localPrompt: () => LocalPermissionPrompt;
  /**
   * How this surface names itself when it reports its own decision back. The
   * daemon records it on the approval, so every other surface can see WHERE the
   * answer came from; there is no honest default, so each product states its own.
   */
  readonly actor: string;
  /** The live session id an ask belongs to, when there is one. */
  readonly sessionId?: () => string | null | undefined;
  /**
   * The push channel for decisions made elsewhere. Omitted ⇒ this surface
   * reads the record on an interval instead, which still works and is slower.
   */
  readonly subscribeApprovalUpdates?: ApprovalUpdateSubscriber | undefined;
  /** Poll interval override (tests), and the fallback interval. */
  readonly pollIntervalMs?: number;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface RaisedRecord {
  readonly id: string;
  readonly status?: string | undefined;
  readonly decision?: {
    readonly approved?: boolean | undefined;
    readonly remember?: boolean | undefined;
    readonly note?: string | undefined;
  } | undefined;
}

/** A record the daemon considers answered, mapped to the decision this surface returns. */
function readRemoteDecision(record: RaisedRecord | null | undefined): PermissionPromptDecision | null {
  if (!record) return null;
  const status = record.status;
  if (status === 'approved') return { approved: true, remember: record.decision?.remember === true };
  if (status === 'denied' || status === 'expired' || status === 'cancelled') {
    return { approved: false, remember: record.decision?.remember === true };
  }
  return null;
}

let unreachableLogged = false;

export function createClientApprovalRaiser(options: ClientApprovalRaiserOptions): ApprovalRaiser {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  const raiseOnDaemon = async (input: {
    request: PermissionPromptRequest;
    routeId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<string | null> => {
    const probe = options.verbs.probe();
    if (!probe.available) {
      if (!unreachableLogged) {
        unreachableLogged = true;
        logger.info(`[approvals] asks are answered on this surface only: ${probe.reason}`);
      }
      return null;
    }
    const sessionId = options.sessionId?.() ?? undefined;
    try {
      const raised = await options.verbs.invoke<{ approval?: RaisedRecord }>('approvals.raise', {
        request: input.request,
        ...(sessionId ? { sessionId } : {}),
        ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return raised?.approval?.id ?? null;
    } catch (error) {
      logger.warn('[approvals] raising the ask on the daemon failed; prompting locally only', { error: summarizeError(error) });
      return null;
    }
  };

  const readRaised = async (approvalId: string): Promise<RaisedRecord | null> => {
    try {
      const listed = await options.verbs.invoke<unknown>('approvals.list', { includeResolved: true });
      const records: readonly RaisedRecord[] = Array.isArray(listed)
        ? listed as readonly RaisedRecord[]
        : ((listed as { approvals?: readonly RaisedRecord[] } | null)?.approvals ?? []);
      return records.find((entry) => entry.id === approvalId) ?? null;
    } catch (error) {
      logger.debug('[approvals] reading the raised ask back failed', { error: summarizeError(error) });
      return null;
    }
  };

  /** The fallback: read the record back on an interval until it is answered. */
  const pollRemote = async (approvalId: string, done: () => boolean): Promise<PermissionPromptDecision | null> => {
    while (!done()) {
      await sleep(pollIntervalMs);
      if (done()) return null;
      const decision = readRemoteDecision(await readRaised(approvalId));
      if (decision) return decision;
    }
    return null;
  };

  /**
   * The push path: subscribe, then read once to close the gap between the raise
   * and the subscription, then wait for the frame that decides this id.
   *
   * Resolves null when the local prompt won, when the stream ended without a
   * decision, or when no stream could be opened — the caller falls back.
   */
  const watchRemoteOverStream = async (
    subscribe: ApprovalUpdateSubscriber,
    approvalId: string,
    done: () => boolean,
  ): Promise<{ readonly subscribed: boolean; readonly decision: PermissionPromptDecision | null }> => {
    let settle: ((decision: PermissionPromptDecision | null) => void) | null = null;
    const decided = new Promise<PermissionPromptDecision | null>((resolve) => { settle = resolve; });
    let subscription: ApprovalUpdateSubscription | null = null;
    try {
      subscription = await subscribe((notice) => {
        if (notice.approval.id !== approvalId) return;
        if (done()) { settle?.(null); return; }
        const decision = readRemoteDecision(notice.approval);
        if (decision) settle?.(decision);
      });
    } catch (error) {
      logger.debug('[approvals] opening the approval-update stream failed; reading the record instead', {
        error: summarizeError(error),
      });
      return { subscribed: false, decision: null };
    }
    if (!subscription) return { subscribed: false, decision: null };
    try {
      // The gap read. A decision taken before the stream opened would otherwise
      // never arrive on it, and this seam would wait for an event that is
      // already in the past.
      const alreadyDecided = readRemoteDecision(await readRaised(approvalId));
      if (alreadyDecided) return { subscribed: true, decision: alreadyDecided };
      if (done()) return { subscribed: true, decision: null };
      return { subscribed: true, decision: await decided };
    } finally {
      subscription.close();
    }
  };

  /** Resolve when the daemon's record for this id is answered. Never rejects. */
  const watchRemote = async (approvalId: string, done: () => boolean): Promise<PermissionPromptDecision | null> => {
    const subscribe = options.subscribeApprovalUpdates;
    if (subscribe) {
      const pushed = await watchRemoteOverStream(subscribe, approvalId, done);
      if (pushed.subscribed) return pushed.decision;
    }
    return await pollRemote(approvalId, done);
  };

  /** Tell the daemon what this surface decided, so its record is the truth. */
  const reportLocalDecision = async (approvalId: string, decision: PermissionPromptDecision): Promise<void> => {
    try {
      await options.verbs.invoke(decision.approved ? 'approvals.approve' : 'approvals.deny', {
        approvalId,
        actor: options.actor,
        actorSurface: options.actor,
        ...(decision.remember ? { remember: true } : {}),
      });
    } catch (error) {
      // The user has already been served; a failed write-back is a
      // record-consistency problem, not a reason to re-ask them.
      logger.warn('[approvals] recording this surface\'s decision on the daemon failed', {
        approvalId,
        error: summarizeError(error),
      });
    }
  };

  return async (input) => {
    const approvalId = await raiseOnDaemon(input);
    const prompt = options.localPrompt();
    if (approvalId === null) return await prompt(input.request);

    let settled = false;
    const local = prompt(input.request).then((decision) => {
      settled = true;
      return { source: 'local' as const, decision };
    });
    const remote = watchRemote(approvalId, () => settled).then((decision) => {
      if (decision) settled = true;
      return decision ? { source: 'remote' as const, decision } : null;
    });

    const winner = await Promise.race([
      local,
      remote.then(async (result) => result ?? await local),
    ]);
    if (winner.source === 'local') void reportLocalDecision(approvalId, winner.decision);
    return winner.decision;
  };
}
