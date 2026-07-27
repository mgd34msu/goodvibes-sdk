/**
 * routes/email-composition.ts — the daemon's own mailbox.
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
 * Errors are translated once, here, into honest statuses. `EmailService`
 * throws plain-language `Error`s — "Email is not enabled", "Email config is
 * invalid", an IMAP/SMTP refusal — and collapsing all of them into 500 would
 * report the operator's own unfinished setup as a server fault.
 */
import { EmailService, type EmailServiceDeps } from '../../email/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
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

/** The slice of the verb-group deps this composition needs. */
export interface EmailCompositionDeps {
  /** Test seam: overrides the whole service, so no real socket is opened. */
  readonly emailGateway?: EmailGatewayService | undefined;
  /** Everything `EmailService` needs. Absent in narrow compositions. */
  readonly emailServiceDeps?: EmailServiceDeps | undefined;
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

export function createDaemonEmailGatewayService(
  deps: EmailCompositionDeps,
): EmailGatewayService | null {
  if (deps.emailGateway) return deps.emailGateway;
  if (!deps.emailServiceDeps) return null;
  const service = new EmailService(deps.emailServiceDeps);

  return {
    async listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult> {
      return guard(async () => {
        const since = input.since === undefined ? undefined : new Date(input.since);
        if (since !== undefined && !Number.isFinite(since.getTime())) {
          throw new GatewayVerbError('since must be a parseable date', 'INVALID_ARGUMENT', 400);
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
          // the mailbox alone is the honest answer — better than a synthetic
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
