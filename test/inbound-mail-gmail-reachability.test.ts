/**
 * inbound-mail-gmail-reachability.test.ts — the Gmail inbound path, driven the
 * way the daemon builds it.
 *
 * Why this file exists rather than another unit test
 * ──────────────────────────────────────────────────
 * `GmailMailSource` was complete, tested and exported, and no production code
 * ever constructed one. `createInboundMailSourceFactory` took the builder as an
 * OPTIONAL dependency (`deps.gmail`), every test that exercised the Gmail arm
 * handed it one, and the only composition that could have supplied it —
 * `composeInboundMail`, via `createBuiltinChannelRuntime` — passed nothing. So
 * `deps.gmail` was `undefined` on every real machine, `create()` answered
 * `null` for `kind: 'gmail'`, and `selectionFacts` reported
 * `googleAdopted: options.gmail !== undefined` — permanently false. An owner
 * with Google adopted and no IMAP configured had no inbound mail at all, and
 * the field's own comment ("Supplied by a composition that has an adopted
 * Google credential") described wiring that did not exist.
 *
 * A test that hands the factory a builder cannot catch that: it is exactly what
 * passed while production had none. So every case here starts at
 * `composeInboundMail` with the option the daemon passes — a Gmail READER
 * resolver over real adopted credentials on disk — and asserts a Gmail source
 * that is actually RUNNING, with a message actually delivered through it.
 *
 * Nothing is stubbed below the composition
 * ────────────────────────────────────────
 * The credentials are a real `~/.gmail-mcp` layout in a temp home, read by the
 * real `nodeGoogleFilePort` through the real `adoptGmailMcpCredentials`. The
 * client is a real `GoogleApiClient` over a real `GoogleTokenManager`. The only
 * substitution is `fetch`, which answers Google's four endpoints from a table —
 * the same seam `gateway-calendar-service.ts` already takes as
 * `GoogleCalendarGatewayServiceOptions.fetch`. Everything between the adopted
 * credential and the delivered message is the shipped code.
 */

import { afterEach, expect, test, describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeInboundMail } from '../packages/sdk/src/platform/daemon/facade-inbound-mail.ts';
import { createDaemonGmailInboundReader } from '../packages/sdk/src/platform/daemon/facade-gmail-reader.ts';
import { MIN_VERIFICATION_WINDOW_MS } from '../packages/sdk/src/platform/google/verification-expectations.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';
import type { ExpectationExpiryReport } from '../packages/sdk/src/platform/email/inbound/expectation-registry.ts';
import type { InboundMailSupervisor } from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { GatewayMethodHandler } from '../packages/sdk/src/platform/control-plane/index.ts';
import type { StructuredNotice } from '../packages/sdk/src/platform/email/inbound-notice.ts';

const WATCHED_ADDRESS = 'owner@gmail.test';
const MAILBOX = 'INBOX';
const START_HISTORY_ID = '900100';
const NEXT_HISTORY_ID = '900250';
const MESSAGE_ID = 'msg-verification-1';

const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

const tmpRoots: string[] = [];
const sweepers: { stopSweeping(): void }[] = [];
afterEach(() => {
  for (const registry of sweepers.splice(0)) registry.stopSweeping();
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp home carrying the `~/.gmail-mcp` files `adoptGmailMcpCredentials` reads. */
function adoptedHome(scope: string): string {
  const home = mkdtempSync(join(tmpdir(), 'gv-gmail-home-'));
  tmpRoots.push(home);
  const dir = join(home, '.gmail-mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gcp-oauth.keys.json'), JSON.stringify({
    installed: { client_id: 'client-id.apps.googleusercontent.com', client_secret: 'client-secret' },
  }));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
    refresh_token: 'refresh-token',
    access_token: 'stale-access-token',
    // Deliberately already expired, so the resolver's own call has to refresh
    // rather than reusing a cached token — the path a restarted daemon takes.
    expiry_date: Date.now() - 60_000,
    scope,
  }));
  return home;
}

interface FetchLog {
  readonly calls: string[];
}

/**
 * Google's four endpoints, answered from a table.
 *
 * Deliberately keyed on the real URLs rather than on a hand-rolled client
 * double: a wrong path, a missing `startHistoryId` or a `format=full` that was
 * never asked for shows up here as an unmatched request rather than as a green
 * test over a call that would 404 in production.
 */
function googleFetch(options: {
  readonly scope: string;
  readonly log: FetchLog;
  readonly historyIdOnProfile?: string;
  readonly profileStatus?: number;
  readonly historyRecords?: unknown[];
}): { fetch: (url: string, init: RequestInit) => Promise<Response> } {
  const scope = options.scope;
  return {
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      options.log.calls.push(`${String(init.method ?? 'GET')} ${url.split('?')[0] ?? url}`);
      const json = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return json({ access_token: 'fresh-access-token', expires_in: 3600, scope });
      }
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) {
        if (options.profileStatus !== undefined && options.profileStatus !== 200) {
          return json({ error: { message: 'Request had insufficient authentication scopes.' } }, options.profileStatus);
        }
        return json({
          emailAddress: WATCHED_ADDRESS,
          messagesTotal: 12,
          threadsTotal: 9,
          historyId: options.historyIdOnProfile ?? START_HISTORY_ID,
        });
      }
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/history')) {
        return json({
          history: options.historyRecords ?? [{ id: '900200', messagesAdded: [{ message: { id: MESSAGE_ID } }] }],
          historyId: NEXT_HISTORY_ID,
        });
      }
      if (url.startsWith(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${MESSAGE_ID}`)) {
        return json({
          id: MESSAGE_ID,
          threadId: 'thread-1',
          labelIds: ['INBOX', 'UNREAD'],
          snippet: 'Confirm your address',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'no-reply@service.test' },
              { name: 'To', value: WATCHED_ADDRESS },
              { name: 'Delivered-To', value: WATCHED_ADDRESS },
              { name: 'Subject', value: 'Confirm your address' },
              { name: 'Date', value: 'Mon, 27 Jul 2026 10:00:00 +0000' },
            ],
            body: { data: Buffer.from('Visit https://service.test/confirm/abc to confirm.', 'utf8').toString('base64url') },
          },
        });
      }
      return json({ error: { message: `unexpected request: ${url}` } }, 500);
    },
  };
}

interface Rig {
  readonly supervisor: InboundMailSupervisor;
  readonly notices: { binding: unknown; notice: StructuredNotice }[];
  readonly log: FetchLog;
}

/**
 * The daemon's own composition, over a temp store root and a temp home.
 *
 * `createDaemonGmailInboundReader` is the exact expression
 * `createBuiltinChannelRuntime` passes as `gmailReader`; nothing here builds a
 * `GmailSourceBuilder` by hand, because a hand-built builder is what made the
 * old Gmail tests pass over a production path that had none.
 */
function composeOrNull(input: {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly scope?: string;
  readonly home?: string;
  readonly profileStatus?: number;
  readonly historyRecords?: unknown[];
} = {}): Rig | null {
  const root = mkdtempSync(join(tmpdir(), 'gv-gmail-inbound-'));
  tmpRoots.push(root);
  const scope = input.scope ?? GMAIL_READONLY;
  const home = input.home ?? adoptedHome(scope);
  const log: FetchLog = { calls: [] };
  const notices: { binding: unknown; notice: StructuredNotice }[] = [];

  const values: Record<string, unknown> = {
    'surfaces.email.inbound.enabled': true,
    // The shape the OWNER's machine has, not a shape that makes the code pass.
    //
    // This read `JSON.stringify([WATCHED_ADDRESS])` — a full Gmail address —
    // and that single substitution hid a defect as complete as the one this
    // file was written for. `surfaces.email.inbound.accounts` is documented in
    // the config schema as "a JSON array of configured mailbox account
    // identifiers to watch for inbound mail, e.g. ["primary"]", and that
    // description is what the owner reads when he fills the key in. With
    // `primary` in it, the old `isGmailMailbox` compared it to the address
    // `users.getProfile` returned, found them unequal, looked for an IMAP host
    // to read a domain off, found none — because this machine has never had
    // IMAP set up, which is the entire premise — and answered false. `auto`
    // then chose IMAP, the IMAP arm had no host to connect to, and the factory
    // answered `null`: the same end state as the defect the Gmail construction
    // fix closed, reached by a different route.
    //
    // So every case below runs over `["primary"]`. The address-equality path is
    // still covered, explicitly, in the config-shape cases at the bottom.
    'surfaces.email.inbound.accounts': JSON.stringify(['primary']),
    'surfaces.email.inbound.source': 'auto',
    'surfaces.email.inbound.notice.mode': 'all',
    'surfaces.email.inbound.notice.route': 'default',
    'surfaces.email.inbound.gmailPollSecondsExpecting': 5,
    'surfaces.email.inbound.gmailPollSecondsIdle': 60,
    'surfaces.email.imap.mailbox': MAILBOX,
    // Deliberately NO surfaces.email.imap.host and NO surfaces.email.user.
    // That is the owner's actual machine: Google adopted, IMAP never set up.
    // Any fallback to IMAP therefore cannot even be constructed, so a Gmail
    // arm that quietly degraded would show up as an inactive supervisor here
    // rather than as a green test over the wrong source.
    ...input.config,
  };

  const supervisor = composeInboundMail({
    configManager: { get: (key: string) => values[key] } as never,
    secretsManager: { get: async () => null } as never,
    shellPaths: { resolveUserPath: (_scope: string, name: string) => join(root, name) } as never,
    routeBindings: {
      listBindings: () => [{ id: 'binding-1', lastSeenAt: 1 }],
      getBinding: (id: string) => (id === 'binding-1' ? { id: 'binding-1', lastSeenAt: 1 } : undefined),
      isRouteBindingEnabled: () => true,
    } as never,
    gatewayMethods: {
      get: (id: string) => ({ id }),
      register: (_descriptor: { id: string }, _handler: GatewayMethodHandler) => undefined,
    } as never,
    deliverStructuredNotice: async (binding, notice) => {
      notices.push({ binding, notice });
      return { delivered: true } as never;
    },
    gmailReader: createDaemonGmailInboundReader({
      configManager: { get: (key: string) => values[key] } as never,
      secretsManager: { get: async () => null } as never,
      homeDirectory: home,
      fetch: googleFetch({
        scope,
        log,
        ...(input.profileStatus === undefined ? {} : { profileStatus: input.profileStatus }),
        ...(input.historyRecords === undefined ? {} : { historyRecords: input.historyRecords }),
      }),
    }),
  });

  if (supervisor === null) return null;
  // The composition arms a periodic expectation sweep. Stopped in `afterEach`,
  // or a timer outlives its temp directory and writes into a path that is gone.
  sweepers.push((supervisor as unknown as {
    deps: { expectations: { stopSweeping(): void } };
  }).deps.expectations);
  return { supervisor, notices, log };
}

/** The same rig, for the cases that expect a supervisor to exist. */
function compose(input: Parameters<typeof composeOrNull>[0] = {}): Rig {
  const rig = composeOrNull(input);
  if (rig === null) throw new Error('composeInboundMail answered null for a configured mailbox');
  return rig;
}

describe('the Gmail inbound path is reachable from the daemon composition', () => {
  /**
   * The gate.
   *
   * Fails if `composeInboundMail` stops constructing a `GmailMailSource`, if
   * `createDaemonGmailInboundReader` stops resolving an adopted credential, or
   * if `createBuiltinChannelRuntime`'s option is removed — the last of those is
   * a compile error, because `gmailReader` is a required field rather than the
   * optional one that let production ship with nothing in it.
   */
  test('an adopted Google credential produces a RUNNING Gmail source, not a null', async () => {
    const rig = compose();
    const status = await rig.supervisor.start();

    expect(status.mode).toBe('polling');
    expect(status.running).toBe(true);

    const snapshot = await rig.supervisor.describeStatus();
    expect(snapshot.source.kind).toBe('gmail');
    expect(snapshot.source.basis).toBe('google-adopted');
    expect(snapshot.capability?.state).toBe('healthy');

    // The profile call is how the position is established, and it is the call
    // `GoogleApiClient` did not have: `currentHistoryId()` had no endpoint
    // behind it, which is the piece that kept the source unbuildable.
    expect(rig.log.calls).toContain('GET https://gmail.googleapis.com/gmail/v1/users/me/profile');

    await rig.supervisor.stop();
  });

  test('a message found over Gmail reaches the owner through the same notice path IMAP uses', async () => {
    const rig = compose();
    await rig.supervisor.start();
    // The first pass establishes the position and does not backfill, so the
    // delivery is proved on the second pass — the one that has a cursor.
    await rig.supervisor.start();

    const snapshot = await rig.supervisor.describeStatus();
    expect(snapshot.source.kind).toBe('gmail');

    const delivered = rig.notices.filter((entry) => entry.notice !== undefined);
    expect(delivered.length).toBeGreaterThan(0);
    expect(JSON.stringify(delivered)).toContain('Confirm your address');

    await rig.supervisor.stop();
  });

  /**
   * BOTH settings, and both because one of them alone proves nothing.
   *
   * `gmailPollSecondsExpecting` and `gmailPollSecondsIdle` were declared in the
   * config schema, shown in the settings UI, documented with their ranges — and
   * read by no code at all, because the only constructor that takes them was
   * never called. An assertion on the idle interval alone survives the
   * expecting one being hardcoded back to its default, which is the same shape
   * of gap that hid the whole path.
   */
  test('both Gmail poll settings reach the source that reads them', async () => {
    const rig = compose({
      config: {
        'surfaces.email.inbound.gmailPollSecondsExpecting': 7,
        'surfaces.email.inbound.gmailPollSecondsIdle': 41,
      },
    });
    await rig.supervisor.start();

    const source = (rig.supervisor as unknown as { source: { latency: { worstCaseMs: number } } }).source;
    // Nothing is expected, so the idle interval is the one in force.
    expect(source.latency.worstCaseMs).toBe(41_000);

    // Open one, and the interval in force must become the short one — the whole
    // reason the source asks the predicate on every read rather than sampling
    // it once at construction.
    const expectations = (rig.supervisor as unknown as {
      deps: { expectations: { open: (input: Record<string, string>) => Promise<unknown> } };
    }).deps.expectations;
    await expectations.open({
      serviceDomain: 'service.test',
      recipientAddress: WATCHED_ADDRESS,
      purpose: 'signup verification',
    });
    expect(source.latency.worstCaseMs).toBe(7_000);

    await rig.supervisor.stop();
  });

  test('no Google credential on the machine is reported in the selection, not guessed at', async () => {
    const bareHome = mkdtempSync(join(tmpdir(), 'gv-gmail-nohome-'));
    tmpRoots.push(bareHome);
    const rig = compose({ home: bareHome });
    const status = await rig.supervisor.start();

    expect(status.mode).toBe('inactive');
    // The old message asserted "no Google credentials have been adopted on this
    // machine" whether or not any had been. The reason now comes from the
    // composition that looked.
    expect(status.reason).toContain('No Google account is connected on this machine');

    await rig.supervisor.stop();
  });

  test('a credential Google refuses is reported with Google own words, never as a quiet IMAP fallback', async () => {
    const rig = compose({ profileStatus: 403 });
    const status = await rig.supervisor.start();

    expect(status.mode).toBe('inactive');
    expect(status.reason).toContain('insufficient authentication scopes');
    // IMAP is not configured at all here, so a fallback would have produced a
    // different, IMAP-flavoured reason. It must not appear.
    expect(status.reason).not.toContain('surfaces.email.imap.host');

    await rig.supervisor.stop();
  });
});

/**
 * The poll-cadence predicate, over the source the daemon actually built.
 *
 * `test/inbound-mail-expectation-probe-is-a-read.test.ts` proves the registry
 * and the book behave; this proves the FACADE asks them the harmless question.
 * The distinction matters because the defect was a call site, not a component:
 * every piece was correct and `expectationOpen: () => expectations.list().length > 0`
 * wired the one read that reaped.
 *
 * Nothing here reaches into the source to call the predicate directly. Reading
 * `source.latency` is what `describeStatus` and the poll loop both do, and the
 * getter asks the predicate — so this is the production caller, driven the
 * production way.
 */
describe('the running Gmail source probes for expectations without reaping them', () => {
  test(
    'an expectation that runs out while the source polls is still REPORTED',
    async () => {
      // `onExpired`, as `composeInboundMail` wires it: a `logger.warn` naming
      // the expectation and its reason. Intercepted on the singleton the facade
      // imports, and removed again so the own-property stops shadowing the
      // prototype method.
      const warned: { message: string; fields: unknown }[] = [];
      const patched = logger as unknown as Record<string, unknown>;
      patched['warn'] = (message: string, fields: unknown): void => {
        warned.push({ message, fields });
      };

      try {
        const rig = compose({
          // No history records, so no message arrives and nothing but the
          // predicate touches the book while this runs.
          historyRecords: [],
          config: {
            // An hour, so the composed sweep timer sits on its 60 s ceiling and
            // cannot be the thing that reports. The expectation below carries
            // its own one-second window regardless.
            'surfaces.email.inbound.expectationWindowMinutes': 60,
          },
        });
        await rig.supervisor.start();

        const internals = rig.supervisor as unknown as {
          source: { latency: { worstCaseMs: number } };
          deps: {
            expectations: {
              open(input: Record<string, unknown>): Promise<{ id: string }>;
              sweep(): Promise<readonly ExpectationExpiryReport[]>;
            };
          };
        };
        const expectations = internals.deps.expectations;

        await expectations.open({
          serviceDomain: 'service.test',
          recipientAddress: WATCHED_ADDRESS,
          purpose: 'signup verification',
          // The book's own minimum, so the window genuinely elapses in real
          // time — this registry runs on the real clock.
          windowMs: MIN_VERIFICATION_WINDOW_MS,
        });
        // The predicate sees it: the source is on the fast cadence.
        expect(internals.source.latency.worstCaseMs).toBe(5_000);

        await new Promise((resolve) => { setTimeout(resolve, 1_400); });

        // Six probes — the half-minute of five-second polls that used to sit
        // between an expiry and the sweep that was supposed to report it. Each
        // one correctly answers "nothing open"; none of them may consume it.
        for (let tick = 0; tick < 6; tick += 1) {
          expect(internals.source.latency.worstCaseMs).toBe(60_000);
        }

        const reports = await expectations.sweep();
        expect(reports).toHaveLength(1);
        expect(reports[0]?.reason).toBe('window-elapsed');
        expect(reports[0]?.recipientAddress).toBe(WATCHED_ADDRESS);

        // The report REACHED the owner's handler. Without this the test would
        // pass on a sweep that returned rows it never announced.
        const announced = warned.filter((entry) =>
          entry.message.includes('expired without a matching message'));
        expect(announced).toHaveLength(1);
        expect(JSON.stringify(announced[0]?.fields)).toContain('window-elapsed');

        await rig.supervisor.stop();
      } finally {
        delete patched['warn'];
      }
    },
    20_000,
  );
});

/**
 * What `surfaces.email.inbound.accounts` is allowed to decide.
 *
 * The credential is the evidence: `resolveGmailInboundReader` opened the grant,
 * Google answered, and `users.getProfile` named the address those credentials
 * read. The config key is a FILTER over that — it can say "watch a different
 * mailbox", and Gmail's API cannot read a different mailbox, so that is a real
 * `false`. What it must not do is be the only way to reach `true`, which is
 * what comparing it to the connected address made it.
 */
describe('Gmail-ness comes from the credential, with accounts as a filter over it', () => {
  const gmailSelected = async (config: Readonly<Record<string, unknown>>): Promise<{
    kind: string | null;
    basis: string;
  }> => {
    const rig = compose({ config });
    await rig.supervisor.start();
    const snapshot = await rig.supervisor.describeStatus();
    await rig.supervisor.stop();
    return { kind: snapshot.source.kind, basis: snapshot.source.basis };
  };

  test('an identifier account with no IMAP host is the connected mailbox — Gmail', async () => {
    // `["primary"]` is the schema description's own example, and this machine
    // has no IMAP host. Nothing here names a mailbox other than the one the
    // credential reads, and the credential resolved.
    expect(await gmailSelected({
      'surfaces.email.inbound.accounts': JSON.stringify(['primary']),
    })).toEqual({ kind: 'gmail', basis: 'google-adopted' });
  });

  test('an account written as the connected address is still direct evidence', async () => {
    expect(await gmailSelected({
      'surfaces.email.inbound.accounts': JSON.stringify([WATCHED_ADDRESS]),
    })).toEqual({ kind: 'gmail', basis: 'google-adopted' });
    // Case and surrounding space are not a different mailbox.
    expect(await gmailSelected({
      'surfaces.email.inbound.accounts': JSON.stringify([`  ${WATCHED_ADDRESS.toUpperCase()}  `]),
    })).toEqual({ kind: 'gmail', basis: 'google-adopted' });
  });

  test('an account naming a DIFFERENT address is not a Gmail mailbox', async () => {
    // The filter doing its job. Gmail's history API reads the mailbox the
    // credentials belong to and cannot read `elsewhere@other.test`, so the
    // owner asking for that mailbox must not be served this one.
    expect(await gmailSelected({
      'surfaces.email.inbound.accounts': JSON.stringify(['elsewhere@other.test']),
    })).toEqual({ kind: 'imap', basis: 'not-a-gmail-account' });
  });

  test('an identifier pointed at a non-Google IMAP host is not a Gmail mailbox', async () => {
    // An identifier claims nothing by itself, but a configured host does: the
    // owner has told the watcher which server this mailbox lives on.
    expect(await gmailSelected({
      'surfaces.email.inbound.accounts': JSON.stringify(['primary']),
      'surfaces.email.imap.host': 'imap.fastmail.test',
      'surfaces.email.user': 'watched@other.test',
    })).toEqual({ kind: 'imap', basis: 'not-a-gmail-account' });
  });

  test('a Google Workspace custom domain over Google IMAP is a Gmail mailbox', async () => {
    // The original rule, unchanged and still right when it fires: the account
    // is a different address AND the host is Google's, which is what a
    // Workspace custom domain looks like.
    expect(await gmailSelected({
      'surfaces.email.inbound.accounts': JSON.stringify(['owner@company.test']),
      'surfaces.email.imap.host': 'imap.gmail.com',
      'surfaces.email.user': 'owner@company.test',
    })).toEqual({ kind: 'gmail', basis: 'google-adopted' });
  });

  /**
   * The one thing an absent `accounts` key still means.
   *
   * Stated here rather than left implicit, because "absent" was the observation
   * that started this and it is a DIFFERENT question from the one above. An
   * empty list is the shipped default, and `composeInboundMail` answers `null`
   * for it on purpose — "an empty list is honest about watching nothing rather
   * than defaulting to a mailbox nobody named". A connected Google credential
   * does not change that: it says which mailbox could be read, not that the
   * owner asked for it to be. `surfaces.email.inbound.enabled` defaults to
   * false for the same reason, and turning it on is what makes the owner name
   * an account.
   */
  test('an absent or empty accounts list composes nothing, credential or no credential', () => {
    expect(composeOrNull({ config: { 'surfaces.email.inbound.accounts': undefined } })).toBeNull();
    expect(composeOrNull({ config: { 'surfaces.email.inbound.accounts': '[]' } })).toBeNull();
  });
});
