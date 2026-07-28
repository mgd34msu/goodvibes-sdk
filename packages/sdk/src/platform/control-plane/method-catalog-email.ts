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
export const builtinGatewayEmailMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'email.inbox.list',
    title: 'List Email Inbox',
    description:
      'Return inbox message summaries fetched live from the configured IMAP account, newest first (ordered by server-assigned UID, never by the sender-written Date header). Read-only (EXAMINE / BODY.PEEK); never marks messages read.',
    category: 'email',
    scopes: ['read:email'],
    http: { method: 'GET', path: '/api/email/inbox' },
    inputSchema: objectSchema({
      limit: NUMBER_SCHEMA,
      since: STRING_SCHEMA,
      unreadOnly: BOOLEAN_SCHEMA,
    }),
    outputSchema: objectSchema({
      messages: arraySchema(EMAIL_INBOX_MESSAGE_SCHEMA),
      total: NUMBER_SCHEMA,
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
];
