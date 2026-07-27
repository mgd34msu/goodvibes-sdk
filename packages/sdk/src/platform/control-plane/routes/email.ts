/**
 * routes/email.ts — the daemon actually serving `email.*`.
 *
 * These four methods shipped cataloged with `invokable: false` because the
 * IMAP/SMTP service that could satisfy them lived inside a single product, so
 * the daemon had nothing to call. The practical consequence was not a 404 on
 * an obscure path: it meant scheduled work, triggers and channel-driven work
 * could not send mail at all, with no product process attached. A reminder
 * that was supposed to arrive by email simply did not.
 *
 * The service is platform capability now (`platform/email`), so this module is
 * the thin part: it maps the descriptors' declared shapes onto a narrow
 * service slice. It performs no I/O, holds no credential, opens no socket, and
 * knows nothing about IMAP or SMTP.
 *
 * Three properties are enforced here rather than merely advertised:
 *
 *  - **`confirm: true` gates the send.** `email.send` is an irreversible
 *    outward effect. The descriptor marks it `dangerous`/`admin` and requires
 *    `confirm` in its schema, and this module refuses without it as well, so
 *    the guarantee does not rest on schema validation being reached by every
 *    transport that can invoke a method.
 *  - **A body is never echoed into an error.** Failures report the stage and
 *    the server's own plain-language reason; the message being sent is not
 *    part of a diagnostic.
 *  - **Read stays read.** `inbox.list` and `inbox.read` are declared read-only
 *    and the underlying client uses `BODY.PEEK`, so serving them over the wire
 *    cannot mark the owner's mail as read.
 *
 * Mail read through here is attacker-controlled text — anyone who knows the
 * address can put words in front of whatever consumes this. The service
 * records an untrusted ingest for every message it returns; a caller that
 * feeds a body onward is responsible for keeping that provenance attached.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import { readInvocationParams } from './invocation-params.js';

/** One inbox message, in the shape `email.inbox.list` advertises. */
export interface EmailGatewayMessageSummary {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  readonly bodyPreview: string;
  readonly messageId: string;
}

export interface EmailGatewayAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** One message, in the shape `email.inbox.read` advertises. */
export interface EmailGatewayMessageDetail {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly messageId: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
  readonly attachments?: readonly EmailGatewayAttachment[];
}

export interface EmailGatewayListInput {
  readonly limit?: number | undefined;
  readonly since?: string | undefined;
  readonly unreadOnly?: boolean | undefined;
}

export interface EmailGatewayListResult {
  readonly messages: readonly EmailGatewayMessageSummary[];
  /** Matches BEFORE `limit` truncation, so a caller can tell there is more. */
  readonly total: number;
}

export interface EmailGatewayDraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
}

export interface EmailGatewayDraftResult {
  /** The draft's Message-ID. Always present. */
  readonly draftId: string;
  /**
   * The APPENDUID the server assigned, when it advertises UIDPLUS. Absent
   * otherwise — a server that does not report one has not given us a uid, and
   * inventing a number a later fetch would not resolve is worse than saying so.
   */
  readonly uid?: number;
  /** The Drafts folder the message actually landed in. */
  readonly mailbox: string;
}

export interface EmailGatewaySendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | undefined;
}

export interface EmailGatewaySendResult {
  readonly messageId: string;
  readonly sentAt: string;
}

/**
 * What a mail backend must be able to do to serve these verbs.
 *
 * Failures are reported by throwing `GatewayVerbError` with an honest status:
 * an unconfigured account is a 400 naming what to configure, a rejected
 * credential a 401, an unknown uid a 404.
 */
export interface EmailGatewayService {
  listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult>;
  readMessage(uid: number): Promise<EmailGatewayMessageDetail | null>;
  createDraft(input: EmailGatewayDraftInput): Promise<EmailGatewayDraftResult>;
  send(input: EmailGatewaySendInput): Promise<EmailGatewaySendResult>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const read = readOptionalString(value);
  if (read === undefined) {
    throw new GatewayVerbError(`${field} (non-empty string) is required`, 'INVALID_ARGUMENT', 400);
  }
  return read;
}

/**
 * A uid is an IMAP UID: a positive integer. A caller that sends `"12"` gets
 * the same answer as one that sends `12`, but `"latest"` is refused rather
 * than coerced to `NaN` and then to some arbitrary message.
 */
function readUid(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new GatewayVerbError('uid (a positive integer IMAP UID) is required', 'INVALID_ARGUMENT', 400);
  }
  return parsed;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readOptionalCount(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.trunc(parsed));
}

export function createEmailInboxListHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    return service.listInbox({
      limit: readOptionalCount(params.limit),
      since: readOptionalString(params.since),
      unreadOnly: readOptionalBoolean(params.unreadOnly),
    });
  };
}

export function createEmailInboxReadHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const uid = readUid(readInvocationParams(invocation).uid);
    const message = await service.readMessage(uid);
    if (message === null) {
      // A uid that no longer resolves is a gone message, not a broken server.
      throw new GatewayVerbError(
        `No message with UID ${String(uid)} is in the mailbox. It may have been moved or deleted since it was listed.`,
        'NOT_FOUND',
        404,
      );
    }
    return message;
  };
}

export function createEmailDraftCreateHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    return service.createDraft({
      to: readRequiredString(params.to, 'to'),
      subject: readRequiredString(params.subject, 'subject'),
      body: readRequiredString(params.body, 'body'),
      inReplyTo: readOptionalString(params.inReplyTo),
      references: readOptionalString(params.references),
    });
  };
}

export function createEmailSendHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    if (params.confirm !== true) {
      throw new GatewayVerbError(
        'email.send puts a message on the internet and cannot be recalled. Re-issue with confirm: true once the recipients and body have been reviewed.',
        'CONFIRMATION_REQUIRED',
        400,
      );
    }
    refuseNonUserRequest(invocation, 'email.send');
    return service.send({
      to: readRequiredString(params.to, 'to'),
      subject: readRequiredString(params.subject, 'subject'),
      body: readRequiredString(params.body, 'body'),
      inReplyTo: readOptionalString(params.inReplyTo),
    });
  };
}

/** Attach the email handlers to their registered descriptors (missing = no-op). */
export function registerEmailGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: EmailGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('email.inbox.list', createEmailInboxListHandler(service));
  attach('email.inbox.read', createEmailInboxReadHandler(service));
  attach('email.draft.create', createEmailDraftCreateHandler(service));
  attach('email.send', createEmailSendHandler(service));
}
