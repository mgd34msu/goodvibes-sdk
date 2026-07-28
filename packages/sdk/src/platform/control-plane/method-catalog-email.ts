import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  STRING_SCHEMA,
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  arraySchema,
  objectSchema,
  bodyEnvelopeSchema,
  methodDescriptor,
} from './method-catalog-shared.js';

const EMAIL_INBOX_MESSAGE_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  from: STRING_SCHEMA,
  subject: STRING_SCHEMA,
  date: STRING_SCHEMA,
  unread: BOOLEAN_SCHEMA,
  bodyPreview: STRING_SCHEMA,
  messageId: STRING_SCHEMA,
}, ['uid', 'from', 'subject', 'date', 'unread', 'bodyPreview', 'messageId']);

/**
 * A FETCH response on the returned page that the client could not read.
 *
 * Present only when there were any. A page can come back short for two
 * different reasons — a message expunged between the search and the fetch, or
 * an answer this client could not read — and `total` cannot tell them apart
 * because it counts the SEARCH match while the loss happens at the FETCH.
 */
const EMAIL_INBOX_UNREADABLE_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  detail: STRING_SCHEMA,
}, ['detail']);

const EMAIL_ATTACHMENT_SCHEMA = objectSchema({
  filename: STRING_SCHEMA,
  contentType: STRING_SCHEMA,
  sizeBytes: NUMBER_SCHEMA,
}, ['filename', 'contentType', 'sizeBytes']);

const EMAIL_MESSAGE_DETAIL_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  from: STRING_SCHEMA,
  subject: STRING_SCHEMA,
  date: STRING_SCHEMA,
  messageId: STRING_SCHEMA,
  bodyText: STRING_SCHEMA,
  bodyHtml: STRING_SCHEMA,
  attachments: arraySchema(EMAIL_ATTACHMENT_SCHEMA),
}, ['uid', 'from', 'subject', 'date', 'messageId', 'bodyText']);

/**
 * Email operator methods — inbox read and outbound send through the standard
 * operator method protocol.
 *
 * These are SERVED. `registerEmailGatewayMethods`
 * (control-plane/routes/email.ts) attaches an in-process handler to each id
 * over an `EmailGatewayService`, the daemon composition supplies the
 * IMAP/SMTP-backed implementation from `platform/email`, and
 * `GATEWAY_REST_ROUTES` maps each advertised http path to the same handler, so
 * the REST path and the methodId-invoke endpoint resolve identically.
 *
 * They did not used to be, and the consequence was not a 404 on an obscure
 * path. For a long time no /api/email surface existed at any prefix and no
 * handler was registered, so these carried `invokable: false` to say
 * "cataloged, not callable" rather than let a caller find out the hard way.
 * The reason was never the routing — the only IMAP/SMTP implementation lived
 * inside one product, so the daemon had nothing to call, and nothing the
 * daemon did unattended could send a message: not a schedule, not a trigger,
 * not a channel reply. Hoisting the service into the SDK is what made serving
 * them possible.
 *
 * The route-reconcile regression gate (method-catalog-route-reconcile.ts,
 * exercised in test/capability-route-reconcile.test.ts) keeps the two halves
 * honest in both directions: a descriptor advertising an http path no route
 * serves reddens it, and so does one that quietly reappears unmarked.
 */
/**
 * An open verification expectation, as the disclosure verbs report it.
 *
 * `authority` is on the wire deliberately. It is the literal
 * `'evidence-only'` on every record, and carrying it means a consumer reads
 * the grant's scope from the record rather than assuming it from the fact
 * that a match occurred: satisfying an expectation establishes control of an
 * address and grants no command authority at all.
 */
const EMAIL_EXPECTATION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  serviceDomain: STRING_SCHEMA,
  recipientAddress: STRING_SCHEMA,
  purpose: STRING_SCHEMA,
  openedAt: STRING_SCHEMA,
  expiresAt: STRING_SCHEMA,
  authority: STRING_SCHEMA,
  remainingMs: NUMBER_SCHEMA,
}, [
  'id', 'kind', 'serviceDomain', 'recipientAddress', 'purpose',
  'openedAt', 'expiresAt', 'authority',
]);

/**
 * One persisted cursor, disclosed.
 *
 * `position` is a STRING on both sources deliberately. A Gmail `historyId` is
 * a decimal uint64 that loses precision the moment it becomes a JS number, and
 * an IMAP position is two numbers rather than one — a single numeric field
 * could only be wrong for one of them.
 */
const EMAIL_INBOUND_CURSOR_SCHEMA = objectSchema({
  account: STRING_SCHEMA,
  mailbox: STRING_SCHEMA,
  source: STRING_SCHEMA,
  position: STRING_SCHEMA,
  updatedAt: STRING_SCHEMA,
  ageMs: NUMBER_SCHEMA,
}, ['account', 'mailbox', 'source', 'position', 'updatedAt', 'ageMs']);

/** An open expectation as the inbound status discloses it (§9.2). */
const EMAIL_INBOUND_EXPECTATION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  serviceDomain: STRING_SCHEMA,
  recipientAddress: STRING_SCHEMA,
  purpose: STRING_SCHEMA,
  openedAt: STRING_SCHEMA,
  expiresAt: STRING_SCHEMA,
  remainingMs: NUMBER_SCHEMA,
}, ['id', 'serviceDomain', 'recipientAddress', 'purpose', 'openedAt', 'expiresAt', 'remainingMs']);

/**
 * The source in force, with its latency stated as a SENTENCE.
 *
 * Not as a millisecond number: the whole reason `SourceLatency` is on the
 * source interface is that "real-time" must never be claimed for a poll, and a
 * consumer handed a raw interval is a consumer that will write that sentence
 * itself, wrongly. `kind` is optional because nothing is in force before a
 * source is selected, and a refusal has no source to name.
 */
const EMAIL_INBOUND_SOURCE_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  basis: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  latency: STRING_SCHEMA,
}, ['basis', 'detail', 'latency']);

/** The runtime capability verdict (§3.4b). Absent before anything is probed. */
const EMAIL_INBOUND_CAPABILITY_SCHEMA = objectSchema({
  state: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  fix: STRING_SCHEMA,
}, ['state', 'reason', 'detail', 'fix']);

/** What each store is holding and what bounds it — the §9 disclosure. */
const EMAIL_INBOUND_RETENTION_SCHEMA = objectSchema({
  cursors: objectSchema({
    kept: NUMBER_SCHEMA,
    maxCursors: NUMBER_SCHEMA,
  }, ['kept', 'maxCursors']),
  records: objectSchema({
    kept: NUMBER_SCHEMA,
    retentionDays: NUMBER_SCHEMA,
    maxRecords: NUMBER_SCHEMA,
    maxBodyExcerptChars: NUMBER_SCHEMA,
  }, ['kept', 'retentionDays', 'maxRecords', 'maxBodyExcerptChars']),
  expectations: objectSchema({
    open: NUMBER_SCHEMA,
    maxOpen: NUMBER_SCHEMA,
  }, ['open', 'maxOpen']),
  lastSweep: objectSchema({
    sweptAt: NUMBER_SCHEMA,
    trigger: STRING_SCHEMA,
    summary: STRING_SCHEMA,
  }, ['sweptAt', 'trigger', 'summary']),
}, ['cursors', 'records', 'expectations']);

/**
 * Email's health entry — shaped like a channel's, and deliberately NOT one.
 *
 * `state`, `enabled`, `id` and `label` line up with `ChannelStatusSnapshot` so
 * a health view renders it in the same list; `surface` is absent because email
 * is not a `ChannelSurface`, and widening that union would hand inbound mail
 * the accounts, delivery and ingress-authorization capabilities §2.1 removes.
 */
const EMAIL_INBOUND_HEALTH_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  state: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  account: STRING_SCHEMA,
  mailbox: STRING_SCHEMA,
  mode: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['kind', 'id', 'label', 'state', 'enabled', 'account', 'mailbox', 'mode', 'reason']);

/** One persisted store's readability, as `describeStores` reports it. */
const EMAIL_INBOUND_STORE_SCHEMA = objectSchema({
  store: STRING_SCHEMA,
  state: STRING_SCHEMA,
  detail: STRING_SCHEMA,
}, ['store', 'state', 'detail']);

/**
 * Whether arriving mail is actually reaching the owner.
 *
 * `state: 'ok'` carries nothing else, which is why every other field is
 * optional here: a refusal has a reason, a fix, a start time and a count, and
 * "notices are getting through" has none of those and must not be padded with
 * empty strings that read as facts.
 */
const EMAIL_INBOUND_NOTICE_DELIVERY_SCHEMA = objectSchema({
  state: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  fix: STRING_SCHEMA,
  since: STRING_SCHEMA,
  unannounced: NUMBER_SCHEMA,
}, ['state']);

export const builtinGatewayEmailMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'email.inbox.list',
    title: 'List Email Inbox',
    description:
      'Return inbox message summaries fetched live from the configured IMAP account, newest first (ordered by server-assigned UID, never by the sender-written Date header). Read-only (EXAMINE / BODY.PEEK); never marks messages read. When the server answered for a message and the daemon could not read the answer, the page is short and `unreadable` says so — an omitted message is not by itself evidence that it was deleted.',
    category: 'email',
    scopes: ['read:email'],
    http: { method: 'GET', path: '/api/email/inbox' },
    inputSchema: objectSchema({
      limit: NUMBER_SCHEMA,
      since: STRING_SCHEMA,
      unreadOnly: BOOLEAN_SCHEMA,
    }),
    // `unreadable` is deliberately NOT required: it is absent on every page
    // that came back whole, which is almost all of them, and a required-but-
    // empty array would make "nothing went wrong" and "nobody looked" the same
    // shape on the wire.
    outputSchema: objectSchema({
      messages: arraySchema(EMAIL_INBOX_MESSAGE_SCHEMA),
      total: NUMBER_SCHEMA,
      unreadable: arraySchema(EMAIL_INBOX_UNREADABLE_SCHEMA),
    }, ['messages', 'total']),
  }),
  methodDescriptor({
    id: 'email.inbox.read',
    title: 'Read Email Message',
    description:
      'Return the full body and attachment metadata for a single inbox message by IMAP UID. Read-only (BODY.PEEK; does not mark as read).',
    category: 'email',
    scopes: ['read:email'],
    http: { method: 'GET', path: '/api/email/inbox/{uid}' },
    inputSchema: objectSchema({ uid: NUMBER_SCHEMA }, ['uid']),
    outputSchema: EMAIL_MESSAGE_DETAIL_SCHEMA,
  }),
  methodDescriptor({
    id: 'email.draft.create',
    title: 'Create Email Draft',
    description:
      'Append a draft message to the configured IMAP Drafts folder. Distinct from the local channel draft store. Requires explicit confirmation.',
    category: 'email',
    scopes: ['write:email'],
    access: 'admin',
    http: { method: 'POST', path: '/api/email/drafts' },
    inputSchema: bodyEnvelopeSchema({
      to: STRING_SCHEMA,
      subject: STRING_SCHEMA,
      body: STRING_SCHEMA,
      inReplyTo: STRING_SCHEMA,
      references: STRING_SCHEMA,
    }, ['to', 'subject', 'body']),
    // `uid` is deliberately NOT required: it is the APPENDUID, which only a
    // server advertising UIDPLUS returns. Requiring it would force a number to
    // be invented for every other server, and an invented uid is one a later
    // fetch cannot resolve. `mailbox` names the Drafts folder the message
    // actually landed in, which differs per provider ([Gmail]/Drafts, Drafts).
    outputSchema: objectSchema({
      draftId: STRING_SCHEMA,
      uid: NUMBER_SCHEMA,
      mailbox: STRING_SCHEMA,
    }, ['draftId', 'mailbox']),
    dangerous: true,
  }),
  methodDescriptor({
    id: 'email.send',
    title: 'Send Email',
    description:
      'Send a composed email via the configured SMTP account. Irreversible external send; requires confirm: true and explicit user review of recipients and body.',
    category: 'email',
    scopes: ['write:email'],
    access: 'admin',
    http: { method: 'POST', path: '/api/email/send' },
    inputSchema: bodyEnvelopeSchema({
      to: STRING_SCHEMA,
      subject: STRING_SCHEMA,
      body: STRING_SCHEMA,
      inReplyTo: STRING_SCHEMA,
      confirm: BOOLEAN_SCHEMA,
    }, ['to', 'subject', 'body', 'confirm']),
    outputSchema: objectSchema({
      messageId: STRING_SCHEMA,
      sentAt: STRING_SCHEMA,
    }, ['messageId', 'sentAt']),
    dangerous: true,
  }),
  /**
   * The three expectation verbs carry NO `http` binding, unlike the mail
   * verbs above.
   *
   * They are not a REST surface. They are how an already-authorized
   * workstream — an account signup, a purchase — declares in advance that a
   * specific message is expected at a specific address from a specific
   * domain, before it submits the form. The callers are inside the daemon,
   * reaching them over the control plane; nothing external consumes them, and
   * a descriptor advertising an `/api/...` path that no route serves is
   * exactly what the route-reconcile gate exists to redden.
   *
   * `transport: ['ws']` follows from that and is not decoration. The default
   * is `['http', 'ws']`, and declaring http while serving no http path is a
   * method advertising a transport it cannot be reached on — which the
   * transport-honesty gate catches, correctly. The declaration has to match
   * the reachability, not the convention.
   *
   * Every input `required` array below is declared explicitly and matches
   * what the handler enforces.
   */
  methodDescriptor({
    id: 'email.expectation.open',
    transport: ['ws'],
    title: 'Open Verification Expectation',
    description:
      'Register, in advance, that a verification message is expected at one address from one service domain, within a bounded window. Called by the workstream that already holds authority BEFORE it submits the signup or checkout form. Grants evidence-only authority: a matching message proves control of the address and can never start work, widen the expectation or extend its window.',
    category: 'email',
    scopes: ['write:email'],
    access: 'admin',
    inputSchema: objectSchema({
      serviceDomain: STRING_SCHEMA,
      recipientAddress: STRING_SCHEMA,
      purpose: STRING_SCHEMA,
      windowMs: NUMBER_SCHEMA,
      kind: STRING_SCHEMA,
    }, ['serviceDomain', 'recipientAddress', 'purpose']),
    outputSchema: EMAIL_EXPECTATION_SCHEMA,
  }),
  methodDescriptor({
    id: 'email.expectation.list',
    transport: ['ws'],
    title: 'List Verification Expectations',
    description:
      'Return every open verification expectation with its recipient, service domain, purpose and remaining window. Disclosure: an expectation is a live correlation key, and the owner is entitled to see which ones exist.',
    category: 'email',
    scopes: ['read:email'],
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      expectations: arraySchema(EMAIL_EXPECTATION_SCHEMA),
      total: NUMBER_SCHEMA,
    }, ['expectations', 'total']),
  }),
  methodDescriptor({
    id: 'email.expectation.cancel',
    transport: ['ws'],
    title: 'Cancel Verification Expectation',
    description:
      'Close an expectation the workstream abandoned. A signup dropped before submission otherwise leaves a live correlation key for an address nobody is waiting on, occupying one of the bounded open slots until its window elapses. Cancelling an id that is not open is an answer, not a failure.',
    category: 'email',
    scopes: ['write:email'],
    access: 'admin',
    inputSchema: objectSchema({ id: STRING_SCHEMA }, ['id']),
    outputSchema: objectSchema({
      cancelled: BOOLEAN_SCHEMA,
      expectation: EMAIL_EXPECTATION_SCHEMA,
    }, ['cancelled']),
  }),
  /**
   * The inbound watcher's disclosure verb (§9).
   *
   * Anything persisted across restarts must say what it holds, and three
   * things outlive a restart here: the cursors, the inbound records, and the
   * expectations. This verb is where the owner reads all three, plus what the
   * watcher is actually doing right now — which source is in force and what
   * that source COSTS in latency, so "real-time" is never claimed for a poll.
   *
   * `transport: ['ws']` for the same reason the expectation verbs carry it:
   * there is no `/api/email/inbound/status` route, and a descriptor
   * advertising a transport it cannot be reached on is what the
   * transport-honesty gate exists to fail.
   */
  methodDescriptor({
    id: 'email.inbound.status',
    transport: ['ws'],
    title: 'Inbound Mail Status',
    description:
      'Disclose the inbound-mail watcher: whether it is running and why, which source is reading the mailbox and the delay that source actually costs, the current capability verdict, every persisted cursor with its position and age, every open verification expectation with its remaining window, whether each store could be read, whether arriving mail is actually being announced to the owner, and what each store retains before it is reaped. Read-only.',
    category: 'email',
    scopes: ['read:email'],
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      enabled: BOOLEAN_SCHEMA,
      running: BOOLEAN_SCHEMA,
      mode: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      account: STRING_SCHEMA,
      mailbox: STRING_SCHEMA,
      source: EMAIL_INBOUND_SOURCE_SCHEMA,
      capability: EMAIL_INBOUND_CAPABILITY_SCHEMA,
      cursors: arraySchema(EMAIL_INBOUND_CURSOR_SCHEMA),
      expectations: arraySchema(EMAIL_INBOUND_EXPECTATION_SCHEMA),
      retention: EMAIL_INBOUND_RETENTION_SCHEMA,
      // Both were served by the handler and undeclared here, which is the same
      // fault the descriptor's own comment names for transports: a disclosure
      // the consumer cannot see the shape of is one it will not read.
      stores: arraySchema(EMAIL_INBOUND_STORE_SCHEMA),
      noticeDelivery: EMAIL_INBOUND_NOTICE_DELIVERY_SCHEMA,
      health: EMAIL_INBOUND_HEALTH_SCHEMA,
    }, [
      'enabled', 'running', 'mode', 'reason', 'account', 'mailbox',
      'source', 'cursors', 'expectations', 'retention', 'stores',
      'noticeDelivery', 'health',
    ]),
  }),
];
