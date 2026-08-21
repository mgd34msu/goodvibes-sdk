/**
 * routes/email-composition.ts, the daemon's own mailbox.
 *
 * Adapts the platform `EmailService` onto the `EmailGatewayService` slice the
 * `email.*` verb handlers are written against. Assembled here rather than in
 * the runtime composition root so one property stays visible: the daemon reads
 * its mail settings and its password from the DAEMON tier and nowhere else, so
 * a setup performed in any surface is usable here the moment it lands and
 * stays usable after that surface exits.
 *
 * Returns `null` when the composition is too narrow to reach a real store, so
 * the verbs stay unregistered rather than half-wired and answering 500s.
 *
 * Three layers, in order, so each is one idea:
 *
 *  1. `createServiceBackedGateway`, the mapping onto `EmailService`, and the
 *     one place its errors become honest statuses. `EmailService` throws
 *     plain-language `Error`s, "Email is not enabled", "Email config is
 *     invalid", an IMAP/SMTP refusal, and collapsing all of them into 500
 *     would report the operator's own unfinished setup as a server fault.
 *  2. `instrumentEmailGateway`, unfinished setup reported in the operator's
 *     own key names, and an operational log line per verb.
 *  3. `createDaemonEmailGatewayService`, which of those a given composition
 *     gets.
 *
 * Every address in a log field is a digest. See `email/address-digest.ts` for
 * why that is not optional.
 */
import { EmailService, type EmailServiceDeps } from '../../email/index.js';
import {
  getProcessUntrustedContentLedger,
  type UntrustedContentLedger,
} from '../../security/untrusted-content.js';
import { addressDigest } from '../../email/address-digest.js';
import type { SurfaceEmailConfigProblem } from '../../email/surface-config.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { resolveOwnerAddresses } from '../../security/owner-identity.js';
import { registerEmailGatewayMethods } from './email.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type {
  EmailGatewayDraftInput,
  EmailGatewayDraftResult,
  EmailGatewayListInput,
  EmailGatewayListResult,
  EmailGatewayMessageDetail,
  EmailGatewaySendInput,
  EmailGatewaySendResult,
  EmailGatewayService,
} from './email.js';

/**
 * One operational log line about a mail verb.
 *
 * Addresses arrive here already reduced to a digest, see `address-digest.ts`
 * for why, and note that this signature makes it awkward to pass anything else:
 * the fields are scalars a log can hold, not a message a log should not.
 */
export type EmailGatewayLog = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

/** The slice of the verb-group deps this composition needs. */
export interface EmailCompositionDeps {
  /** Test seam: overrides the whole service, so no real socket is opened. */
  readonly emailGateway?: EmailGatewayService | undefined;
  /** Everything `EmailService` needs. Absent in narrow compositions. */
  readonly emailServiceDeps?: EmailServiceDeps | undefined;
  /**
   * The ledger a mailbox read is recorded into.
   *
   * Defaults to the process-wide one, the SAME ledger the daemon's browser
   * engine records page reads into (routes/browser-composition.ts). Sharing it
   * is the point: reading a stranger's page and reading a stranger's mail are
   * the same kind of exposure, and a send made afterwards discloses both from
   * one record rather than from two that cannot see each other.
   */
  readonly untrustedContentLedger?: UntrustedContentLedger | undefined;
  /**
   * Why the mailbox is not usable yet, in the operator's own key names.
   *
   * Supplied when the settings come from the daemon's `surfaces.email.*` keys,
   * because the service's own validation reports `email.imapHost is required`,
   * a key that operator does not have and cannot set. Absent for a plain
   * `email.*` composition, where that wording is the correct wording.
   */
  readonly describeEmailConfigProblem?: (() => Promise<SurfaceEmailConfigProblem | null>) | undefined;
  /** Operational log sink. Absent means these verbs log nothing at all. */
  readonly emailLog?: EmailGatewayLog | undefined;
}

/**
 * Not-configured and refused-credentials are the operator's to fix, so they
 * are 400/401 with the service's own wording rather than a bare 500.
 */
function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/not enabled/i.test(message)) {
    throw new GatewayVerbError(message, 'EMAIL_NOT_ENABLED', 400);
  }
  if (/config is invalid|is not configured/i.test(message)) {
    throw new GatewayVerbError(message, 'EMAIL_NOT_CONFIGURED', 400);
  }
  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials|535|LOGIN failed/i.test(message)) {
    throw new GatewayVerbError(
      `${message} The stored mail password was refused; store a current one and retry.`,
      'EMAIL_CREDENTIALS_REJECTED',
      401,
    );
  }
  throw new GatewayVerbError(message, 'EMAIL_REQUEST_FAILED', 502);
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GatewayVerbError) throw error;
    return translate(error);
  }
}

/** The `EmailGatewayService` slice, served by a platform `EmailService`. */
export function createServiceBackedGateway(service: EmailService): EmailGatewayService {
  return {
    async listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult> {
      return guard(async () => {
        const since = input.since === undefined ? undefined : new Date(input.since);
        if (since !== undefined && !Number.isFinite(since.getTime())) {
          throw new GatewayVerbError('since must be a parseable date', 'INVALID_ARGUMENT', 400, 'since');
        }
        const result = await service.listInbox({
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(since === undefined ? {} : { since }),
          ...(input.unreadOnly === undefined ? {} : { unreadOnly: input.unreadOnly }),
        });
        return {
          messages: result.messages.map((message) => ({
            uid: message.uid,
            from: message.from,
            subject: message.subject,
            date: message.date,
            unread: message.unread,
            bodyPreview: message.bodyPreview,
            messageId: message.messageId,
          })),
          total: result.total,
          ...(result.unreadable !== undefined && result.unreadable.length > 0
            ? {
              unreadable: result.unreadable.map((problem) => ({
                ...(problem.uid === null ? {} : { uid: problem.uid }),
                detail: problem.detail,
              })),
            }
            : {}),
        };
      });
    },

    async readMessage(uid: number): Promise<EmailGatewayMessageDetail | null> {
      return guard(async () => {
        const message = await service.readMessage(uid);
        if (message === null) return null;
        return {
          uid: message.uid,
          from: message.from,
          subject: message.subject,
          date: message.date,
          messageId: message.messageId,
          bodyText: message.bodyText,
          ...(message.bodyHtml.length > 0 ? { bodyHtml: message.bodyHtml } : {}),
          ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        };
      });
    },

    async createDraft(input: EmailGatewayDraftInput): Promise<EmailGatewayDraftResult> {
      return guard(async () => {
        const result = await service.createDraft({
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          ...(input.references === undefined ? {} : { references: input.references }),
        });
        return {
          // Built only from what the server actually told us: the folder it
          // landed in, and the APPENDUID when the server advertises UIDPLUS.
          // Without a uid there is no per-draft identifier to hand back, and
          // the mailbox alone is the honest answer, better than a synthetic
          // id that no later fetch could resolve.
          draftId: result.uid === null ? result.mailbox : `${result.mailbox}:${String(result.uid)}`,
          ...(result.uid === null ? {} : { uid: result.uid }),
          mailbox: result.mailbox,
        };
      });
    },

    async send(input: EmailGatewaySendInput): Promise<EmailGatewaySendResult> {
      return guard(async () => {
        const result = await service.sendMail({
          to: input.to,
          subject: input.subject,
          body: input.body,
          // The handler already refused anything without an explicit
          // confirm: true from the caller; this is the service's own
          // belt-and-braces precondition, not a second decision.
          confirm: true,
        });
        return { messageId: result.messageId, sentAt: result.sentAt };
      });
    },
  };
}

export interface EmailGatewayInstrumentation {
  readonly describeEmailConfigProblem?: (() => Promise<SurfaceEmailConfigProblem | null>) | undefined;
  readonly emailLog?: EmailGatewayLog | undefined;
}

/**
 * Wrap a mail backend with the two things every caller of these verbs should
 * get regardless of what is behind them: unfinished setup reported in terms the
 * operator can act on, and a log line that says what happened without saying
 * who it happened with.
 */
export function instrumentEmailGateway(
  backend: EmailGatewayService,
  options: EmailGatewayInstrumentation,
): EmailGatewayService {
  const log: EmailGatewayLog = options.emailLog ?? ((): void => {});

  /** Refuse before the mailbox is touched when setup is not finished. */
  async function ready(): Promise<void> {
    const problem = await options.describeEmailConfigProblem?.();
    if (problem) throw new GatewayVerbError(problem.message, problem.code, 400);
  }

  return {
    async listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult> {
      await ready();
      const result = await backend.listInbox(input);
      log('email.inbox.list', {
        count: result.messages.length,
        unreadOnly: input.unreadOnly ?? true,
        // Digested, and joined rather than listed one per sender: the line says
        // how many distinct people wrote, never who.
        senders: result.messages.map((message) => addressDigest(message.from)).join(','),
      });
      return result;
    },

    async readMessage(uid: number): Promise<EmailGatewayMessageDetail | null> {
      await ready();
      const message = await backend.readMessage(uid);
      if (message === null) return null;
      log('email.inbox.read', {
        uid,
        from: addressDigest(message.from),
        hasHtml: message.bodyHtml !== undefined && message.bodyHtml.length > 0,
        attachments: message.attachments?.length ?? 0,
      });
      return message;
    },

    async createDraft(input: EmailGatewayDraftInput): Promise<EmailGatewayDraftResult> {
      await ready();
      const result = await backend.createDraft(input);
      log('email.draft.create', {
        mailbox: result.mailbox,
        ...(result.uid === undefined ? {} : { uid: result.uid }),
        recipient: addressDigest(input.to),
      });
      return result;
    },

    async send(input: EmailGatewaySendInput): Promise<EmailGatewaySendResult> {
      await ready();
      const result = await backend.send(input);
      log('email.send', {
        messageId: result.messageId,
        sentAt: result.sentAt,
        recipient: addressDigest(input.to),
      });
      return result;
    },
  };
}

export function createDaemonEmailGatewayService(
  deps: EmailCompositionDeps,
): EmailGatewayService | null {
  const ledger = deps.untrustedContentLedger ?? getProcessUntrustedContentLedger();
  const backend = deps.emailGateway
    ?? (deps.emailServiceDeps
      ? createServiceBackedGateway(new EmailService({
        ...deps.emailServiceDeps,
        // Bound here rather than left to the caller: a composition that forgot
        // it would read strangers' mail into nothing, and the exposure a later
        // send discloses would be missing exactly the half that mattered. This
        // is the SAME process-wide ledger the daemon's browser engine records
        // page reads into, so reading a stranger's page and reading a
        // stranger's mail accrue to one record rather than two that cannot see
        // each other. A caller that supplies its own recorder still wins.
        recordUntrustedIngest: deps.emailServiceDeps.recordUntrustedIngest
          ?? ((ingest) => { ledger.record(ingest); }),
      }))
      : null);
  if (backend === null) return null;
  return instrumentEmailGateway(backend, {
    describeEmailConfigProblem: deps.describeEmailConfigProblem,
    emailLog: deps.emailLog,
  });
}

/**
 * Register the daemon's `email.*` verbs, with the owner identity the taint
 * exemption needs.
 *
 * Lives here rather than at the verb-group root so the whole mail composition
 *, service, instrumentation, and now the owner's own addresses, is decided
 * in one file. The addresses are read from the daemon's configuration and from
 * nowhere a message can reach; empty leaves the taint refusal in force rather
 * than guessing at an identity. See security/owner-identity.ts.
 */
export function registerDaemonEmailVerbs(
  catalog: GatewayMethodCatalog,
  deps: EmailCompositionDeps & { readonly configManager?: { get(key: never): unknown } | undefined },
): void {
  const gateway = createDaemonEmailGatewayService(deps);
  if (!gateway) return;
  const getConfig = deps.configManager;
  registerEmailGatewayMethods(
    catalog,
    gateway,
    undefined,
    getConfig === undefined
      ? new Set<string>()
      : resolveOwnerAddresses((key) => getConfig.get(key as never)),
  );
}
