/**
 * routes/email.ts, the daemon actually serving `email.*`.
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
 * Mail read through here is attacker-controlled text, anyone who knows the
 * address can put words in front of whatever consumes this. The service
 * records an untrusted ingest for every message it returns; a caller that
 * feeds a body onward is responsible for keeping that provenance attached.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import {
  UNTRUSTED_CONTENT_RULE,
  getProcessUntrustedContentLedger,
  type UntrustedContentLedger,
} from '../../security/untrusted-content.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { evaluateOutwardEffect } from '../../security/untrusted-content.js';
import { isSendToOwnerOnly } from '../../security/owner-identity.js';
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

/** A FETCH response on the returned page the daemon could not read. */
export interface EmailGatewayUnreadableResponse {
  /** The UID the response named, or absent when it named none legibly. */
  readonly uid?: number;
  readonly detail: string;
}

export interface EmailGatewayListResult {
  readonly messages: readonly EmailGatewayMessageSummary[];
  /** Matches BEFORE `limit` truncation, so a caller can tell there is more. */
  readonly total: number;
  /**
   * Answers on THIS page the daemon could not read. Absent when there were
   * none.
   *
   * Without it a short page is silent, and a caller reading `messages` against
   * `total` cannot tell "that message was deleted between the search and the
   * fetch" from "that message is in the mailbox and we could not read what the
   * server said about it". The first is ordinary; the second means the owner
   * is looking at a list that is missing mail and reading it as complete.
   */
  readonly unreadable?: readonly EmailGatewayUnreadableResponse[];
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
   * otherwise, a server that does not report one has not given us a uid, and
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
    throw new GatewayVerbError(`${field} (non-empty string) is required`, 'INVALID_ARGUMENT', 400, field);
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
    throw new GatewayVerbError('uid (a positive integer IMAP UID) is required', 'INVALID_ARGUMENT', 400, 'uid');
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

/**
 * Why a send DISCLOSES its untrusted exposure rather than refusing on it.
 *
 * The daemon's browser verbs and its mail verbs record into one ledger (see
 * routes/browser-composition.ts), so "read a page, then send mail" is one
 * composition rather than two unrelated acts. In the agent, that composition
 * is REFUSED: an owner turn has a start, so exposure has a scope, and the
 * refusal's fix, take it to the owner, has someone to take it to.
 *
 * An unattended daemon has neither. Nothing marks a turn boundary, so a single
 * page read would silently disable outbound mail for the life of the process;
 * and "ask the owner" is not available to a job running at 3am, which is the
 * work this capability exists for. Refusing here would break the exact
 * scheduled-work path the browser and mail verbs were served for.
 *
 * So the daemon reports instead of hiding: every send made while the ledger
 * holds untrusted exposure carries the origins that produced it and the
 * standing rule, on the send receipt, where a reader and an audit both see it.
 * The engine's own refusals are untouched, a page this daemon read still
 * cannot cause a form submission, which is the effect page content can reach
 * on its own.
 */
function untrustedExposureDisclosure(ledger: UntrustedContentLedger): Record<string, unknown> {
  const origins = ledger.originsThisTurn();
  if (origins.length === 0) return {};
  return {
    untrustedContent: {
      originsInScope: [...origins],
      rule: UNTRUSTED_CONTENT_RULE,
      note: 'This process has read content from these sources. The send passed the derivation check, none of its recipient, subject or body repeats what was read, and the provenance travels with the receipt so a reader can still weigh it.',
    },
  };
}

/**
 * Refuse a send whose content derives from something a stranger wrote.
 *
 * The daemon used to only DISCLOSE this, on the reasoning that an unattended
 * process has nobody to take a refusal to. That is backwards for this threat:
 * a disclosure is a note in a receipt nobody reads, on the one surface with no
 * human watching, and an unattended daemon is precisely where a prompt
 * injection pays off. The daemon is the STRICTEST surface now, not the most
 * permissive.
 *
 * The check is on derivation, not exposure, which is what makes strictness
 * affordable: a scheduled report that queries a database and mails a summary
 * derives from nothing anyone wrote at it and proceeds. Disclosure is kept for
 * the sends that do proceed, it stops being the only protection.
 */
function refuseTaintedSend(
  ledger: UntrustedContentLedger,
  fields: Readonly<Record<string, string | undefined>>,
  description: string,
  replyToEnvelopeSenders: readonly string[] = [],
  ownerAddresses: ReadonlySet<string> = new Set(),
): void {
  // The one exemption: a send whose EVERY recipient is the owner himself.
  //
  // He is the trust root, not a third party, and telling him what arrived is
  // the point of an assistant reading his mail. "What came in overnight" is a
  // summary that necessarily reuses the words of what came in, so without this
  // the feature is refused in its most ordinary use.
  //
  // Deliberately narrow: his configured addresses only, not a domain, not a
  // pattern, and not partial. A send to the owner AND anyone else is not
  // exempt, because naming him first and slipping a second recipient in beside
  // him is exactly how this would be abused. Identity comes from configuration
  // and never from anything a message can influence; see
  // security/owner-identity.ts for what an attacker would have to control.
  //
  // Note what is NOT exempted: link validation, the confirmation gate, and the
  // explicit-user-request rule all still apply to a send to the owner.
  if (isSendToOwnerOnly(fields.to, ownerAddresses)) return;
  const decision = evaluateOutwardEffect({
    request: { toolName: 'email', action: 'email.send', description },
    ledger,
    content: fields,
    taintOptions: {
      // The recipient is where the mail GOES; length thresholds are the wrong
      // instrument for it, so it is tested by containment.
      exactMatchFields: ['to'],
      // …with one exemption: replying to where a message actually came from,
      // established from delivery evidence rather than a From: header.
      replyToEnvelopeSenders,
      // A reply quoting what it answers repeats it by design.
      stripQuotedFields: ['body'],
    },
  });
  if (decision.allowed) return;
  throw new GatewayVerbError(
    `${decision.reason ?? 'Refused.'} ${decision.fix ?? ''}`.trim(),
    'UNTRUSTED_CONTENT_DERIVED',
    403,
  );
}

export function createEmailSendHandler(
  service: EmailGatewayService,
  /**
   * The ledger the daemon's page reads and mailbox reads both record into.
   * Defaults to the process-wide one, which is what production wants; tests
   * pass their own so one case's page read cannot colour the next case's send.
   */
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
  /**
   * The owner's own addresses, from configuration. Empty disables the
   * owner-destination exemption rather than widening it, see
   * security/owner-identity.ts.
   */
  ownerAddresses: ReadonlySet<string> = new Set(),
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    if (params.confirm !== true) {
      throw new GatewayVerbError(
        'email.send puts a message on the internet and cannot be recalled. Re-issue with confirm: true once the recipients and body have been reviewed.',
        'CONFIRMATION_REQUIRED',
        400,
        'confirm',
      );
    }
    refuseNonUserRequest(invocation, 'email.send');
    const to = readRequiredString(params.to, 'to');
    const subject = readRequiredString(params.subject, 'subject');
    const body = readRequiredString(params.body, 'body');
    // Before anything leaves the machine: does what is about to leave derive
    // from what was read? Recipient included, a redirected reply is as much
    // an injection outcome as a rewritten body.
    refuseTaintedSend(ledger, { to, subject, body }, `sending mail to ${to}`, [], ownerAddresses);
    const sent = await service.send({
      to,
      subject,
      body,
      inReplyTo: readOptionalString(params.inReplyTo),
    });
    return { ...sent, ...untrustedExposureDisclosure(ledger) };
  };
}

/** Attach the email handlers to their registered descriptors (missing = no-op). */
export function registerEmailGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: EmailGatewayService,
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
  /** See createEmailSendHandler. Empty means the exemption cannot fire. */
  ownerAddresses: ReadonlySet<string> = new Set(),
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('email.inbox.list', createEmailInboxListHandler(service));
  attach('email.inbox.read', createEmailInboxReadHandler(service));
  attach('email.draft.create', createEmailDraftCreateHandler(service));
  attach('email.send', createEmailSendHandler(service, ledger, ownerAddresses));
}
