/**
 * facade-inbound-mail.ts, assembling the inbound-mail graph for the daemon.
 *
 * Every piece here already exists and is already tested. This file is the
 * wiring, and it is separate from `facade-composition.ts` for the same reason
 * `facade-cluster.ts` is: it is one subsystem's decisions in one place, and the
 * decisions are the kind that must be visible rather than buried in a hundred
 * lines of unrelated construction.
 *
 * Three of those decisions are worth reading before changing anything.
 *
 * **The stores live under `~/.goodvibes/daemon/`**, `resolveUserPath('daemon',
 * …)`, the surface-scoped mechanism, not a hand-built path. All three outlive a
 * restart, so all three are swept at load by the housekeeper before the watcher
 * serves any mail.
 *
 * **The expectation book is constructed HERE, once, with the real authority
 * probe.** It had never been constructed in production at all: its own
 * defensive check, refuse to open an expectation if email ever gained command
 * authority, could not have fired, because there was nothing for it to fire
 * in. `InboundExpectationRegistry` defaults to the genuine predicate, so
 * building it is what takes that check off the shelf.
 *
 * **The verbs are registered here too.** `email.expectation.open/list/cancel`
 * were cataloged with no production call site, which made the whole capability
 * inert in exactly the way §2.3 describes, the middle of the chain missing
 * while both ends worked. They are attached to the registry that this function
 * builds, alongside `email.inbound.status` over the supervisor.
 *
 * **The Gmail source is CONSTRUCTED here, and that is new.** `GmailMailSource`
 * was complete, tested and exported, and nothing in production ever built one:
 * `createInboundMailSourceFactory` took the builder as an optional `deps.gmail`
 * and this file passed nothing, so the factory answered `null` for
 * `kind: 'gmail'` on every machine while `selectionFacts` reported
 * `googleAdopted: options.gmail !== undefined`, permanently false. An owner
 * with Google adopted and no IMAP set up therefore had no inbound mail at all,
 * and was told "no Google credentials have been adopted on this machine".
 *
 * So `gmailReader` is a REQUIRED option rather than an optional one. The
 * compiler is the gate: a composition that stops supplying it stops building,
 * which is the one check that cannot itself go inert. The reader arrives as a
 * provider (see `facade-gmail-reader.ts`); the cursor store, the expectation
 * predicate and the clock are this file's own; and the poll cadence and the
 * capability re-probe wait arrive on the builder's input, read once in
 * `source-factory.ts` at create time. One key, one reader, a second read here
 * would be a second answer to a question the owner has already answered, and
 * the config gate accepts either call form so it could not tell them apart.
 *
 * **Whether this mailbox is a Gmail one is decided from the CREDENTIAL.** See
 * `isGmailMailbox`: a resolved reader is Google having answered, and
 * `surfaces.email.inbound.accounts` is read as a filter over that rather than
 * as the evidence for it. Making the config key the evidence is what let this
 * path stay dead for an owner who filled the key in the way its own description
 * tells him to.
 */

import {
  GmailMailSource,
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  createInboundMailIntake,
  createInboundMailSourceFactory,
  createInboundNoticeHealth,
  createInboundTerminalFailureAnnouncer,
  expectationSweepIntervalMs,
  resolveWatcherSettings,
  systemWatcherClock,
  type GmailSourceBuilder,
  type InboundMailObserver,
  type InboundNoticeMode,
  type NoticeRouteResolution,
} from '../email/inbound/index.js';
import type {
  GmailInboundReaderProvider,
  GmailInboundReaderResolution,
} from '../google/gmail-inbound-reader.js';
import { nodeEmailTransport } from '../email/node.js';
import { readSurfaceEmailSettings } from '../email/surface-config.js';
import { registerEmailExpectationGatewayMethods } from '../control-plane/routes/email-expectations.js';
import { registerEmailInboundStatusGatewayMethod } from '../control-plane/routes/email-inbound-status.js';
import { logger } from '../utils/logger.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { GatewayMethodCatalog } from '../control-plane/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import type { StructuredNotice } from '../email/inbound-notice.js';
import type { SurfaceNoticeDelivery } from './types.js';

/** How many accounts one supervisor watches. One, today, see `readWatchedAccount`. */
const DEFAULT_MAILBOX = 'INBOX';

export interface InboundMailCompositionOptions {
  readonly configManager: ConfigManager;
  readonly secretsManager: Pick<SecretsManager, 'get'>;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  /**
   * `isRouteBindingEnabled` is in the slice deliberately. Without it, a build
   * with `integrations.routeBinding` switched off is indistinguishable from one
   * where the owner has simply connected nothing: both answer `[]` from
   * `listBindings()`, and inbound mail silently became a recorder.
   */
  readonly routeBindings: Pick<
    RouteBindingManager,
    'listBindings' | 'getBinding' | 'isRouteBindingEnabled'
  >;
  readonly gatewayMethods: GatewayMethodCatalog;
  /**
   * `DaemonSurfaceDeliveryHelper.deliverStructuredNotice`.
   *
   * Takes the STRUCTURE, not a rendered string, so nothing on the inbound path
   * ever holds channel-formatted text. The helper resolves the surface from the
   * binding and picks the escaper there, the only code that turns spans into
   * text is the code that knows where they are going.
   */
  readonly deliverStructuredNotice: (
    binding: AutomationRouteBinding | undefined,
    notice: StructuredNotice,
  ) => Promise<SurfaceNoticeDelivery>;
  /**
   * How this machine's Google credential is turned into Gmail-reading I/O.
   *
   * REQUIRED, deliberately. Its optional predecessor (`gmail?:
   * GmailSourceBuilder`) is what let the whole Gmail path ship inert: nothing
   * ever filled it, and an unfilled optional field is indistinguishable from a
   * machine with no Google account. A required provider that ANSWERS
   * `unavailable` with a reason carries the same information and cannot be
   * forgotten, `createBuiltinChannelRuntime` stops compiling if it is dropped.
   *
   * Called once per supervisor start rather than held as a resolved value, so a
   * credential adopted while the daemon is running is picked up on the next
   * start instead of at the next restart.
   */
  readonly gmailReader: GmailInboundReaderProvider;
}

/**
 * The account this node watches.
 *
 * `surfaces.email.inbound.accounts` is a JSON array so the design can grow to
 * several mailboxes; today one supervisor watches the first entry, and an
 * empty list is honest about watching nothing rather than defaulting to a
 * mailbox nobody named.
 */
function readWatchedAccount(configManager: ConfigManager): string | null {
  const raw = configManager.get('surfaces.email.inbound.accounts');
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const first = parsed.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return first?.trim() ?? null;
  } catch {
    // A malformed list is a configuration error, not a mailbox. Reported by
    // the supervisor's status rather than guessed at here.
    return null;
  }
}

/** The resolution, with the full binding this file needs to hand the delivery helper. */
type NoticeRouteAnswer =
  | { readonly kind: 'bound'; readonly binding: AutomationRouteBinding }
  | Extract<NoticeRouteResolution, { kind: 'unavailable' }>;

/**
 * Where the owner is told about inbound mail (§8), or why there is nowhere.
 *
 * A named binding id wins. `default`, the shipped value, means "inherit
 * whatever he already uses", and with no separate owner-notice-route concept
 * in the platform, the honest reading of that is the route binding most
 * recently seen: the one he last reached the daemon on.
 *
 * Every arm that cannot produce a binding names ITSELF rather than collapsing
 * to one `null`, and that is the fix rather than a nicety. Three genuinely
 * different states used to arrive here identically:
 *
 *  - route binding is switched off, so `listBindings()` answers `[]` no matter
 *    how many bindings are stored. An unrelated feature flag, silently turning
 *    inbound mail into a recorder.
 *  - the owner has connected no channel at all, which is a fresh install.
 *  - `surfaces.email.inbound.notice.route` names a binding that is not there,
 *    which is a typo or a binding that was removed.
 *
 * All three were recorded as `no-route-binding` and none of them was reported
 * as anything, so a message the owner never heard about looked the same as a
 * message he had never configured a route for. The record still says
 * `no-route-binding`, that is the delivery layer's vocabulary and the store's
 *, while the condition surfaced through `email.inbound.status` and the health
 * entry carries the reason and its own remedial step.
 */
function resolveNoticeRoute(
  configManager: ConfigManager,
  routeBindings: InboundMailCompositionOptions['routeBindings'],
): NoticeRouteAnswer {
  if (!routeBindings.isRouteBindingEnabled()) {
    return {
      kind: 'unavailable',
      reason: 'route-binding-disabled',
      detail: 'route binding is switched off, so the daemon has no notice routes at all and '
        + 'every arriving message is being recorded without ever being announced.',
      fix: 'Set integrations.routeBinding to true, or set surfaces.email.inbound.notice.mode to '
        + '"none" if recording without announcing is what you want.',
    };
  }
  const configured = configManager.get('surfaces.email.inbound.notice.route');
  if (typeof configured === 'string' && configured.trim().length > 0 && configured.trim() !== 'default') {
    const named = routeBindings.getBinding(configured.trim());
    if (named) return { kind: 'bound', binding: named };
    return {
      kind: 'unavailable',
      reason: 'notice-route-not-found',
      detail: `surfaces.email.inbound.notice.route names the route binding "${configured.trim()}", `
        + 'and there is no binding with that id.',
      fix: 'Point surfaces.email.inbound.notice.route at a binding that exists, or set it back to '
        + '"default" to use the route you most recently reached the daemon on.',
    };
  }
  let newest: AutomationRouteBinding | null = null;
  for (const binding of routeBindings.listBindings()) {
    if (newest === null || binding.lastSeenAt > newest.lastSeenAt) newest = binding;
  }
  if (newest !== null) return { kind: 'bound', binding: newest };
  return {
    kind: 'unavailable',
    reason: 'no-route-binding',
    detail: 'no channel has ever been connected, so there is no route to announce arriving mail '
      + 'on and every message is being recorded silently.',
    fix: 'Connect a channel the daemon can reach you on (Telegram, Slack, ntfy, …), or point '
      + 'surfaces.email.inbound.notice.route at an existing route binding.',
  };
}

/** The binding for a send, or `undefined` so the delivery helper refuses by its own name. */
function noticeBindingFor(
  configManager: ConfigManager,
  routeBindings: InboundMailCompositionOptions['routeBindings'],
): AutomationRouteBinding | undefined {
  const route = resolveNoticeRoute(configManager, routeBindings);
  return route.kind === 'bound' ? route.binding : undefined;
}

function readNoticeMode(configManager: ConfigManager): InboundNoticeMode {
  const mode = configManager.get('surfaces.email.inbound.notice.mode');
  return mode === 'none' || mode === 'expected-only' ? mode : 'all';
}

function readNumberSetting(configManager: ConfigManager, key: Parameters<ConfigManager['get']>[0], fallback: number): number {
  const value = configManager.get(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build the inbound-mail supervisor and register its verbs, or answer `null`
 * when this composition watches no mailbox.
 *
 * `null` is not a failure and it is not silence: `BuiltinChannelRuntime`
 * reports at ERROR when inbound mail is enabled and nothing was composed, and
 * the cluster registration declines to contest a surface this node cannot
 * serve, a node that won that election would stand every other node down and
 * then read nothing.
 */
export function composeInboundMail(
  options: InboundMailCompositionOptions,
): InboundMailSupervisor | null {
  const { configManager, shellPaths } = options;
  const account = readWatchedAccount(configManager);
  if (account === null) return null;

  const mailbox = readSurfaceEmailSettings((key) => configManager.get(key as never)).mailbox
    ?? DEFAULT_MAILBOX;

  const storePath = (name: string): string => shellPaths.resolveUserPath('daemon', name);
  const cursors = new MailboxCursorStore(storePath('email-inbound-cursors.json'), {
    // Reaping a cursor whose account left the config is the store's first
    // rule, and it needs to know what "in config" means.
    isAccountConfigured: (candidate) => candidate === account,
  });
  const records = new InboundMailStore(storePath('email-inbound-records.json'), {
    policy: {
      retentionMs: readNumberSetting(configManager, 'surfaces.email.inbound.retentionDays', 30) * 86_400_000,
      maxRecords: readNumberSetting(configManager, 'surfaces.email.inbound.maxRecords', 5_000),
    },
  });
  const expectationStore = new PersistedExpectationStore(storePath('email-inbound-expectations.json'));
  const housekeeper = new InboundMailHousekeeper({
    cursors,
    records,
    expectations: expectationStore,
    disclosurePath: storePath('email-inbound-housekeeping.json'),
  });

  // Declared before the registry and assigned after the supervisor, so the
  // registry can ASK for the live capability verdict without either object
  // having to be constructed twice. The probe answers `null` until the
  // supervisor exists and until it has probed anything, which is the honest
  // answer: nothing has looked at the mailbox yet.
  let supervisor: InboundMailSupervisor | undefined;

  const expectationWindowMs = readNumberSetting(
    configManager, 'surfaces.email.inbound.expectationWindowMinutes', 15,
  ) * 60_000;

  const expectations = new InboundExpectationRegistry({
    store: expectationStore,
    defaultWindowMs: expectationWindowMs,
    // §12 gate #31: an expectation opened against a mailbox already known
    // unreadable is refused at open time, so the workstream learns now rather
    // than from a fifteen-minute silence it cannot tell from "nothing came".
    capability: () => supervisor?.capability ?? null,
    onExpired: (report) => {
      // §2.3: an expectation that ends without its message fails with a named
      // reason and is REPORTED, rather than lapsing into silence.
      logger.warn(
        report.reason === 'capability-lost'
          ? 'A verification expectation was failed because the mailbox stopped being readable'
          : 'A verification expectation expired without a matching message',
        {
          surface: 'email-inbound',
          expectation: report.id,
          serviceDomain: report.serviceDomain,
          reason: report.reason,
          ...(report.capabilityReason === undefined ? {} : { capabilityReason: report.capabilityReason }),
          detail: report.detail,
        },
      );
    },
  });

  const settings = resolveWatcherSettings({
    account,
    mailbox,
    mode: readInboundMode(configManager),
    pollIntervalMs: readNumberSetting(configManager, 'surfaces.email.inbound.pollIntervalSeconds', 120) * 1_000,
    idleReissueMs: readNumberSetting(configManager, 'surfaces.email.inbound.idleReissueMinutes', 27) * 60_000,
    maxBackoffMs: readNumberSetting(configManager, 'surfaces.email.inbound.reconnect.maxBackoffSeconds', 300) * 1_000,
    capabilityRecheckMs: readNumberSetting(configManager, 'surfaces.email.inbound.capabilityRecheckMinutes', 60) * 60_000,
  });

  // ONE instance, shared by the intake that writes it and the supervisor that
  // reports it. Two instances would be two answers to "is he being told", and
  // the one the status verb read would be the one nothing wrote to.
  const noticeHealth = createInboundNoticeHealth();

  // §3.4b, §12 gates #32 and #33. The announcer tells the owner about terminal
  // failures; the registry has to know about them too, because an expectation
  // is a promise to watch a mailbox and a mailbox that cannot be read makes
  // that promise unkeepable. Composed here rather than folded into the
  // announcer: they are two consumers of one fact, and an announcer that also
  // retired expectations would be doing something its name does not say.
  //
  // `capabilityChanged` itself is the one that decides what to fail, a
  // `degraded` transition (reconnecting, backing off) fails NOTHING, because
  // the reconnect fetches everything above the cursor.
  const announcer = createInboundTerminalFailureAnnouncer({
    send: (notice) => options.deliverStructuredNotice(
      noticeBindingFor(configManager, options.routeBindings),
      notice,
    ),
  });
  const observer: InboundMailObserver = {
    terminalFailure: (failure) => { announcer.terminalFailure(failure); },
    stateChanged: (transition) => {
      announcer.stateChanged(transition);
      void expectations.capabilityChanged(transition.to).catch((error: unknown) => {
        // The watcher must keep running whatever happens here, and the owner
        // must not be left thinking expectations were retired when they were
        // not. Reported rather than swallowed.
        logger.error('Open expectations could not be failed after a capability change', {
          surface: 'email-inbound',
          reason: transition.to.reason,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };

  /**
   * The reader resolved by the start that is happening right now.
   *
   * `InboundMailSupervisor.start()` asks `selectionFacts()` and then, if the
   * selection came out `gmail`, asks the factory to build the source. Those are
   * two steps of ONE decision, so the second must use the credential the first
   * decided on. Resolving twice would open the credential store twice and, on a
   * revocation landing between them, would build a source over a grant the
   * selection had not approved.
   *
   * Reset to null before every resolve so a stale reader can never serve a
   * later start: a restart after a credential was removed must see `null`, not
   * the reader the previous start happened to obtain.
   */
  let resolved: GmailInboundReaderResolution | null = null;

  const gmailBuilder: GmailSourceBuilder = async (input) => {
    const resolution = resolved ?? await options.gmailReader();
    if (resolution.kind !== 'ready') return null;
    return new GmailMailSource({
      account: input.account,
      mailbox: input.mailbox,
      history: resolution.reader.history,
      currentHistoryId: resolution.reader.currentHistoryId,
      cursors,
      sink: input.sink,
      clock: systemWatcherClock,
      // The predicate, not the registry: §2.1's structural rule is that a
      // source must not hold anything that could OPEN an expectation, and a
      // closure over a presence question is a boolean where the registry would
      // be a capability. See `ExpectationPresence` in gmail-source.ts.
      //
      // `hasOpen()` rather than `list().length > 0`, and that is a correctness
      // fix rather than a tidier spelling. `list()` reaped what it found
      // expired and dropped the reports, and this predicate runs every five
      // seconds while an expectation is open, far faster than the thirty-second
      // reporting sweep, so it won the race every time and a verification that
      // never arrived expired without anybody being told. See
      // `InboundExpectationRegistry.hasOpen`.
      expectationOpen: () => expectations.hasOpen(),
      // The owner's own cadence, read from his two Gmail poll settings by
      // `source-factory.ts` at CREATE time and handed in here. Not re-read:
      // one key, one reader. A second read in this file would be a second
      // answer to the same question, and the config gate cannot see the
      // difference because it accepts either call form.
      pollExpectingMs: input.pollExpectingMs,
      pollIdleMs: input.pollIdleMs,
      // The same re-probe wait the IMAP path uses, from the same setting, so a
      // refused grant is re-asked at one interval rather than two. Also handed
      // in, from the `settings` this file resolved and passed to the factory.
      capabilityRecheckMs: input.capabilityRecheckMs,
      // `surfaces.email.inbound.onInsufficientCapability`, read once by
      // `source-factory.ts` at CREATE time and handed in, one key, one reader,
      // the rule the two poll intervals are annotated with above. Re-reading it
      // here would be a second answer to a question that decides whether the
      // daemon announces mail it can never act on.
      capabilityPolicy: input.capabilityPolicy,
      observer,
    });
  };

  supervisor = new InboundMailSupervisor({
    config: configManager,
    account,
    mailbox,
    sources: createInboundMailSourceFactory({
      getConfig: (key) => configManager.get(key as never),
      secrets: options.secretsManager,
      transport: nodeEmailTransport,
      cursors,
      settings,
      gmail: gmailBuilder,
    }),
    // Asked at every start, so a Google credential adopted after boot is seen
    // on the next start rather than at the next restart.
    //
    // `googleAdopted` is the answer from a composition that actually opened the
    // credential and asked Google for the mailbox, not, as it was, the
    // presence of an injected builder that nothing ever injected. When it is
    // false the reason travels with it, because "no account connected", "the
    // grant was refused" and "Google could not be reached" need three different
    // actions and used to arrive as one silent `false`.
    selectionFacts: async () => {
      resolved = null;
      const resolution = await options.gmailReader();
      resolved = resolution;
      if (resolution.kind !== 'ready') {
        return {
          googleAdopted: false,
          mailAccountIsGmail: false,
          gmailUnavailable: `${resolution.detail}${resolution.fix === '' ? '' : ` ${resolution.fix}`}`,
        };
      }
      return {
        googleAdopted: true,
        mailAccountIsGmail: isGmailMailbox(configManager, account, resolution.reader.address),
      };
    },
    cursors,
    records,
    expectations,
    expectationPolicy: expectationStore,
    housekeeper,
    noticeHealth,
    handle: createInboundMailIntake({
      expectations: expectations.matcher,
      records,
      notices: {
        resolveBinding: () => resolveNoticeRoute(configManager, options.routeBindings),
        send: (notice) => options.deliverStructuredNotice(
          noticeBindingFor(configManager, options.routeBindings),
          notice,
        ),
      },
      noticeMode: () => readNoticeMode(configManager),
      now: () => new Date(),
      noticeHealth,
    }),
    // §3.4b: a terminal state is ANNOUNCED, not merely recorded. This used to
    // be a `logger.error` and nothing else, the once-per-transition tracker
    // built, and its sink a log line, for the one condition that means no mail
    // will ever arrive again. It goes to the owner through the same structured
    // notice port arriving mail goes through, and still logs.
    observer,
  });

  registerEmailExpectationGatewayMethods(options.gatewayMethods, expectations);
  registerEmailInboundStatusGatewayMethod(options.gatewayMethods, supervisor);
  housekeeper.start(6 * 60 * 60_000);
  // The call `sweep()` never had. Beside the housekeeper's timer and not inside
  // the supervisor's start, because `email.expectation.open` can register an
  // expectation while no source is running, and a daemon watching no mailbox
  // is exactly when an expectation running out would otherwise be reported by
  // nothing. Six hours is right for reaping records off disk; it is not right
  // for a promise measured in minutes, so this runs on its own cadence.
  expectations.startSweeping(expectationSweepIntervalMs(expectationWindowMs));
  return supervisor;
}

function readInboundMode(configManager: ConfigManager): 'idle' | 'poll' | 'auto' {
  const mode = configManager.get('surfaces.email.inbound.mode');
  return mode === 'idle' || mode === 'poll' ? mode : 'auto';
}

/**
 * Whether the mailbox this node watches is one the adopted Google credential
 * can read.
 *
 * **The credential is the evidence. Configuration is a filter over it.** That
 * ordering is the fix, and the previous ordering is why this had to be fixed
 * twice.
 *
 * A resolved reader means `users.getProfile` answered: the credential works,
 * and it names the address those credentials read. That is a fact obtained from
 * Google. The previous version asked instead whether the first entry of
 * `surfaces.email.inbound.accounts` equalled that address, which made a
 * configuration convention the source of truth, and the convention does not
 * hold. The schema calls that key a list of "mailbox account identifiers, e.g.
 * `["primary"]`", its description is what the owner reads when he sets it, and
 * `sameAddress('primary', 'owner@gmail.com')` is false. So an owner who
 * connected Google, turned inbound mail on and filled the key in the way its
 * own description tells him to got `mailAccountIsGmail: false`, `auto` chose
 * IMAP, and, with no IMAP host configured, which is the whole premise of this
 * path, the factory answered `null`: the exact end state the Gmail
 * construction fix was written to close. Only a key holding a full Gmail
 * address made it work, and the test that covered it set one.
 *
 * So the question this asks is no longer "does config prove it is Gmail" but
 * "does config name a DIFFERENT mailbox". Three arms:
 *
 * **The account names an address.** It is compared, because an owner who wrote
 * an address meant that mailbox. Equal to the connected one is direct evidence.
 * Different, and Gmail's API cannot read it, unless the configured IMAP host
 * is a Google one, which is the Workspace-custom-domain case below.
 *
 * **The account is an identifier, and no IMAP host is configured.** Nothing
 * names another mailbox, and a working Google credential does name one. True.
 * This is the owner's machine.
 *
 * **The account is an identifier and an IMAP host IS configured.** He has
 * pointed this watcher at a specific server; whether it is a Gmail mailbox is
 * that host's domain to answer, exactly as before.
 *
 * The IMAP-host test is unchanged and still right when it fires: an address at
 * a Google Workspace custom domain is a Gmail mailbox whatever it looks like,
 * and an `@gmail.com` address forwarded into somebody else's IMAP server is
 * not.
 */
function isGmailMailbox(
  configManager: ConfigManager,
  account: string,
  connectedAddress: string,
): boolean {
  const host = (readSurfaceEmailSettings((key) => configManager.get(key as never)).imapHost ?? '')
    .trim().toLowerCase();
  if (namesAnAddress(account)) {
    if (sameAddress(account, connectedAddress)) return true;
    return isGoogleHost(host);
  }
  // No host configured: nothing in this machine's configuration names a mailbox
  // other than the one the credential reads, and the credential resolved. That
  // is direct evidence, not a fallback, `resolveGmailInboundReader` has
  // already proved the grant works and asked Google which address it belongs
  // to. An `unavailable` resolution never reaches here at all; the caller
  // answers `mailAccountIsGmail: false` with the reader's own reason.
  if (host.length === 0) return true;
  return isGoogleHost(host);
}

/**
 * Whether an `accounts` entry is an email address or a mailbox identifier.
 *
 * The schema allows both, `["primary"]` is its own example, and they mean
 * different things here: an address is a claim about WHICH mailbox and gets
 * compared, an identifier is a label for this watcher and claims nothing.
 * Treating an identifier as an address is what produced a false negative for
 * every owner who followed the description.
 *
 * A local part, an `@`, and a dotted domain. Deliberately not RFC 5322: this
 * only has to separate `owner@gmail.com` from `primary`, and a permissive
 * pattern that accepted `primary` as an address would put it straight back on
 * the arm that compares.
 */
function namesAnAddress(account: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.trim());
}

/** Whether a configured IMAP host is one of Google's. Takes it already normalized. */
function isGoogleHost(host: string): boolean {
  return /(^|\.)(gmail\.com|googlemail\.com|google\.com)$/.test(host);
}

/**
 * Address equality, case-folded and trimmed, and nothing cleverer.
 *
 * Deliberately NOT Gmail's dot-and-plus folding. Deciding that
 * `o.wner+tag@gmail.com` is the same mailbox as `owner@gmail.com` would be this
 * file inventing a provider rule, and being wrong about it means watching a
 * mailbox the owner did not name. An address that needs folding is one the
 * owner can write the way Google reports it.
 */
function sameAddress(left: string, right: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase();
  const a = normalize(left);
  return a.length > 0 && a === normalize(right);
}
