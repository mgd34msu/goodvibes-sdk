/**
 * What each built-in surface can be SEEN to be doing.
 *
 * Split by how the surface actually receives, because that is what decides
 * whether liveness is knowable at all:
 *
 * - Telegram runs a supervisor on this node, which already tracks its own mode
 *   and the named reason it is not receiving. That supervisor's status is the
 *   answer to "is Telegram working", and until this file existed nothing read
 *   it — `BuiltinChannelRuntime.telegramIngressStatus()` had no caller while
 *   the reported state was computed from the token's presence instead.
 * - Slack, Discord and ntfy hold a long-lived connection managed by
 *   `ChannelProviderRuntimeManager`, which knows whether it is up and what
 *   last broke it.
 * - Every other built-in surface receives by having an HTTP route registered
 *   and waiting to be called. Nothing on this node distinguishes "the provider
 *   is delivering" from "the provider stopped delivering", so those surfaces
 *   report `unknown` and say that configuration is all they know.
 */
import type { ProviderRuntimeStatus, ProviderRuntimeSurface } from '../provider-runtime.js';
import type { TelegramIngressStatus } from '../telegram/ingress.js';
import { observedRuntime, resolveChannelHealthState, unobservableRuntime } from '../health.js';
import type {
  ChannelAccountRecord,
  ChannelRuntimeObservation,
  ChannelStatusSnapshot,
  ChannelSurface,
} from '../types.js';

/**
 * Surfaces whose inbound path is a webhook this daemon merely registers.
 *
 * Kept as a predicate over the surface rather than a list of names so a surface
 * added later is unobservable by default — the safe direction. A new surface
 * that CAN be observed has to say so by getting its own branch in
 * `observeBuiltinRuntime`, which is a change a reader will notice.
 */
function describeUnobservableSurface(surface: ChannelSurface): string {
  return `nothing on this node watches ${surface}: it receives through a registered webhook, so a provider that `
    + 'stopped delivering looks exactly like a quiet one. Configuration is all this status knows.';
}

/**
 * Telegram's supervisor state, read as health.
 *
 * `running` is false in webhook mode by design — the supervisor runs no loop
 * once Telegram has been told where to POST — so mode, not the loop flag,
 * decides. Reading the flag alone would report a correctly armed webhook as
 * dead, which is the same class of wrong answer in the other direction.
 */
export function observeTelegramRuntime(status: TelegramIngressStatus | null): ChannelRuntimeObservation {
  if (!status) {
    return observedRuntime(
      false,
      'Telegram ingress has not been started on this node, so no message can arrive. '
      + 'The daemon arms it at startup; if it is enabled and this persists, the composition root never called startIngress().',
    );
  }
  if (status.mode === 'webhook') {
    return observedRuntime(true, status.reason);
  }
  if (status.mode === 'polling') {
    return status.running
      ? observedRuntime(true, status.reason)
      : observedRuntime(false, `Telegram polling is not running: ${status.reason}`);
  }
  return observedRuntime(false, status.reason);
}

/**
 * A provider connection this node holds open.
 *
 * A host that wired no provider runtime at all gets `unknown`, not `dead`: the
 * connection is not down, it is unwatched, and those are different sentences.
 */
export function observeProviderRuntime(
  surface: ProviderRuntimeSurface,
  status: ProviderRuntimeStatus | null,
): ChannelRuntimeObservation {
  if (!status) {
    return unobservableRuntime(
      `no provider runtime is wired into this host, so the ${surface} connection is unwatched. `
      + 'Configuration is all this status knows.',
    );
  }
  if (status.running) {
    return observedRuntime(
      true,
      `the ${surface} ${status.transport} connection is open`,
      status.lastError,
    );
  }
  return observedRuntime(
    false,
    status.lastError
      ? `the ${surface} ${status.transport} connection is not running: ${status.lastError}`
      : `the ${surface} ${status.transport} connection is not running, so nothing inbound is being read`,
    status.lastError,
  );
}

export interface BuiltinRuntimeObservers {
  /** The Telegram supervisor's current state, or null when it was never built. */
  readonly telegramIngressStatus: () => TelegramIngressStatus | null;
  /** The provider connection manager's state, or null when none is wired. */
  readonly providerRuntimeStatus: (surface: ProviderRuntimeSurface) => ProviderRuntimeStatus | null;
}

/** The live observation for one built-in surface. */
export function observeBuiltinRuntime(
  observers: BuiltinRuntimeObservers,
  surface: ChannelSurface,
): ChannelRuntimeObservation {
  if (surface === 'telegram') return observeTelegramRuntime(observers.telegramIngressStatus());
  if (surface === 'slack' || surface === 'discord' || surface === 'ntfy') {
    return observeProviderRuntime(surface, observers.providerRuntimeStatus(surface));
  }
  if (surface === 'tui') {
    return observedRuntime(true, 'the terminal surface is served in this process; it has no remote path that can fail');
  }
  if (surface === 'web') {
    return unobservableRuntime(
      'nothing here confirms the control-plane listener is accepting connections; web.enabled reflects '
      + 'configuration only. Configuration is all this status knows.',
    );
  }
  return unobservableRuntime(describeUnobservableSurface(surface));
}

export interface BuiltinSnapshotInput {
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly enabled: boolean;
  /** The account record, read for credential presence — never for health. */
  readonly account: ChannelAccountRecord;
  readonly runtime: ChannelRuntimeObservation;
  readonly metadata: Record<string, unknown>;
}

/**
 * Whether a credential for this surface is declared.
 *
 * Deliberately NOT `account.configured`: that flag is true for every surface,
 * because the account id falls back to the literal `surface:<name>` when no
 * real identifier is set, so `Boolean(accountId || ...)` can never be false.
 * `linked` is the honest reading — at least one secret is declared somewhere.
 * The two surfaces with nothing to configure are named, rather than being swept
 * in by a rule that would also sweep in a surface that failed to resolve.
 */
function credentialDeclared(account: ChannelAccountRecord): boolean {
  if (account.surface === 'tui' || account.surface === 'web') return true;
  return account.linked;
}

/**
 * Whether a declared credential actually resolves in the store this process
 * reads. `resolved` is absent only on a record built by an older describer;
 * falling back to `configured` there keeps the previous reading rather than
 * inventing a failure out of a missing field.
 */
function credentialResolves(account: ChannelAccountRecord): boolean {
  if (account.surface === 'tui' || account.surface === 'web') return true;
  return account.secrets.some((secret) => secret.resolved ?? secret.configured);
}

/**
 * Say which fields are declared and do not resolve, so the reported reason
 * names the setting to fix instead of the symptom.
 */
function describeUnresolvedCredentials(account: ChannelAccountRecord): string {
  const fields = account.secrets
    .filter((secret) => secret.configured && secret.resolved === false)
    .map((secret) => secret.label);
  const named = fields.length > 0 ? fields.join(', ') : 'its credential';
  return `${account.label} is configured but cannot send: ${named} names a secret that does not resolve in the store `
    + 'this process reads. A goodvibes://secrets/... reference pointing at a key held in another surface\'s store '
    + '(or an empty store) reads as configured and delivers nothing. Put the secret in THIS surface\'s store, or '
    + 'point the setting at one that resolves here.';
}

/** One snapshot, built the same way for every built-in surface. */
export function buildBuiltinStatusSnapshot(input: BuiltinSnapshotInput): ChannelStatusSnapshot {
  const configured = credentialDeclared(input.account);
  const resolves = credentialResolves(input.account);
  const state = resolveChannelHealthState({
    enabled: input.enabled,
    configured,
    credentialResolves: resolves,
    runtime: input.runtime,
  });
  // An unresolvable credential IS an observation — we looked in the store and
  // the secret was not there — so it replaces the live-path reason rather than
  // leaving the reader with "nothing watches this surface" as the account of a
  // channel that provably cannot send.
  const runtime = state === 'unresolved'
    ? observedRuntime(false, describeUnresolvedCredentials(input.account))
    : input.runtime;
  return {
    id: `surface:${input.surface}`,
    surface: input.surface,
    label: input.label,
    state,
    enabled: input.enabled,
    configured,
    credentialResolves: resolves,
    runtime,
    ...(input.account.accountId ? { accountId: input.account.accountId } : {}),
    metadata: input.metadata,
  };
}
