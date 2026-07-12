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
 * Email operator methods — exposes the agent's IMAP/SMTP capabilities through the
 * standard operator method protocol so email operations can be triggered via MCP
 * connector actions in addition to the direct-socket path. Daemon-backed; the SDK
 * publishes the typed contract surface (no internal handler).
 *
 * Capability-advertisement honesty: none of these four http paths are
 * currently served by the daemon router — there is no /api/email surface at
 * any prefix (confirmed by reading router.ts and every dispatch chain it
 * delegates to; see method-catalog-route-reconcile.ts). The daemon's own 404
 * handler names an /api/email-vs-/api/v1-shaped skew, but that's a red
 * herring here: this isn't a path that moved, it's a path that was never
 * wired to a route or an internal handler at all. Per the "reality wins"
 * fix (correct the path where the route moved, mark unavailable where no
 * route exists), these are marked `invokable: false` so the published
 * contract and the live method-dispatch path both say "cataloged, not
 * callable" instead of letting a caller discover the 404 the hard way.
 * Un-mark a method once its real IMAP/SMTP-backed route or handler exists —
 * the route-reconcile regression gate (method-catalog-route-reconcile.ts,
 * exercised in test/capability-route-reconcile.test.ts) will catch it
 * if this comment goes stale and a route reappears without the flag being
 * cleared, or a new advertise-without-route method slips in unmarked.
 */
export const builtinGatewayEmailMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'email.inbox.list',
    title: 'List Email Inbox',
    description:
      'Return inbox message summaries fetched live from the configured IMAP account. Read-only (EXAMINE / BODY.PEEK); never marks messages read.',
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
    invokable: false,
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
    invokable: false,
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
    outputSchema: objectSchema({
      uid: NUMBER_SCHEMA,
      draftId: STRING_SCHEMA,
    }, ['uid', 'draftId']),
    dangerous: true,
    invokable: false,
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
    invokable: false,
  }),
];
