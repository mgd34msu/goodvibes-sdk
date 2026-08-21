/**
 * Tests for driving `EmailService` from the daemon's own `surfaces.email.*`
 * keys, and for the property that no raw mail address reaches a log field.
 *
 * Both config spellings are exercised, the nested one the settings surface
 * writes (`surfaces.email.imap.host`) and the flat one the inbound poller reads
 * (`surfaces.email.imapHost`), because both are live in the field and a
 * machine configured either way has to keep working.
 *
 * Nothing here opens a socket: the config port is a map, the secret store is a
 * map, and the gateway service is driven through a fake `EmailService`-shaped
 * backend.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SURFACE_EMAIL_PASSWORD_REF,
  SURFACE_EMAIL_SMTP_PASSWORD_REF,
  createSurfaceEmailConfigReader,
  createSurfaceEmailSecretReader,
  describeSurfaceEmailConfigProblem,
  readSurfaceEmailSettings,
} from '../packages/sdk/src/platform/email/surface-config.ts';
import { addressDigest } from '../packages/sdk/src/platform/email/address-digest.ts';
import { daemonSecretKeyFor } from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import { readEmailConfig, smtpPasswordRefFor } from '../packages/sdk/src/platform/email/email-service.ts';
import { createDaemonEmailGatewayService } from '../packages/sdk/src/platform/control-plane/routes/email-composition.ts';
import { createEmailSendHandler } from '../packages/sdk/src/platform/control-plane/routes/email.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../packages/sdk/src/platform/security/untrusted-content.ts';
import { createCalendarEventsCreateHandler } from '../packages/sdk/src/platform/control-plane/routes/calendar.ts';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { EmailGatewayService } from '../packages/sdk/src/platform/control-plane/routes/email.ts';
import type { CalendarGatewayService } from '../packages/sdk/src/platform/control-plane/routes/calendar.ts';

function reader(values: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => {
    if (!(key in values)) throw new Error(`Invalid config path: ${key}`);
    return values[key];
  };
}

function secrets(values: Record<string, string>) {
  return {
    async get(key: string): Promise<string | null> {
      return values[key] ?? null;
    },
  };
}

const NESTED: Record<string, unknown> = {
  'surfaces.email.host': 'mail.example.com',
  'surfaces.email.user': 'mike@example.com',
  'surfaces.email.imap.host': 'imap.example.com',
  'surfaces.email.imap.port': 1993,
  'surfaces.email.imap.mailbox': 'Archive',
  'surfaces.email.imap.draftsMailbox': '[Gmail]/Drafts',
  'surfaces.email.smtp.host': 'smtp.example.com',
  'surfaces.email.smtp.port': 587,
  'surfaces.email.smtp.secure': false,
  'surfaces.email.from': 'Mike <mike@example.com>',
};

const FLAT: Record<string, unknown> = {
  'surfaces.email.imapHost': 'imap.flat.example.com',
  'surfaces.email.imapPort': '1143',
  'surfaces.email.imapUser': 'flat@example.com',
  'surfaces.email.smtp.host': 'smtp.flat.example.com',
};

// ---------------------------------------------------------------------------
// Config precedence
// ---------------------------------------------------------------------------

describe('surfaces.email config precedence', () => {
  test('the nested spelling wins, and the shared host backs the rest', () => {
    const settings = readSurfaceEmailSettings(reader(NESTED));
    expect(settings.imapHost).toBe('imap.example.com');
    expect(settings.imapPort).toBe(1993);
    expect(settings.smtpHost).toBe('smtp.example.com');
    expect(settings.smtpPort).toBe(587);
    expect(settings.smtpSecure).toBe(false);
    expect(settings.username).toBe('mike@example.com');
    expect(settings.fromAddress).toBe('Mike <mike@example.com>');
    expect(settings.mailbox).toBe('Archive');
    expect(settings.draftsMailbox).toBe('[Gmail]/Drafts');
  });

  test('the shared host serves both protocols when neither is overridden', () => {
    const settings = readSurfaceEmailSettings(reader({
      'surfaces.email.host': 'mail.example.com',
      'surfaces.email.user': 'mike@example.com',
    }));
    expect(settings.imapHost).toBe('mail.example.com');
    expect(settings.smtpHost).toBe('mail.example.com');
    expect(settings.imapPort).toBe(993);
    expect(settings.smtpPort).toBe(465);
    expect(settings.smtpSecure).toBe(true);
  });

  test('the flat spelling is honoured when nothing nested is set', () => {
    const settings = readSurfaceEmailSettings(reader(FLAT));
    expect(settings.imapHost).toBe('imap.flat.example.com');
    expect(settings.imapPort).toBe(1143);
    expect(settings.username).toBe('flat@example.com');
  });

  test('a machine that resolved through the shared host keeps resolving that way', () => {
    // Both spellings present: the order the mail handlers already used wins, so
    // upgrading cannot silently move a working mailbox to a different server.
    const settings = readSurfaceEmailSettings(reader({
      ...FLAT,
      'surfaces.email.host': 'mail.example.com',
      'surfaces.email.user': 'mike@example.com',
    }));
    expect(settings.imapHost).toBe('mail.example.com');
    expect(settings.username).toBe('mike@example.com');
  });

  test('username falls back to the alternate spelling, and from falls back to the account', () => {
    const settings = readSurfaceEmailSettings(reader({
      'surfaces.email.host': 'mail.example.com',
      'surfaces.email.username': 'alt@example.com',
    }));
    expect(settings.username).toBe('alt@example.com');
    expect(settings.fromAddress).toBe('alt@example.com');
  });

  test('an absent config section reads as unset instead of throwing', () => {
    const settings = readSurfaceEmailSettings(() => {
      throw new Error('Invalid config path: surfaces.email.host');
    });
    expect(settings.imapHost).toBeUndefined();
    expect(settings.imapPort).toBe(993);
  });
});

// ---------------------------------------------------------------------------
// The EmailService view of those keys
// ---------------------------------------------------------------------------

describe('surfaces.email as an email.* config reader', () => {
  test('EmailService reads a complete, valid config through the adapter', () => {
    const config = readEmailConfig(createSurfaceEmailConfigReader(reader(NESTED)));
    expect(config).toEqual({
      enabled: true,
      imapHost: 'imap.example.com',
      imapPort: 1993,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      imapSecurity: 'tls',
      smtpSecurity: 'starttls',
      username: 'mike@example.com',
      passwordRef: SURFACE_EMAIL_PASSWORD_REF,
      smtpPasswordRef: SURFACE_EMAIL_SMTP_PASSWORD_REF,
      fromAddress: 'Mike <mike@example.com>',
      mailbox: 'Archive',
      draftsMailbox: '[Gmail]/Drafts',
    });
  });

  test('smtp.secure decides the security mode rather than the port guessing', () => {
    const secure = readEmailConfig(createSurfaceEmailConfigReader(reader({
      ...NESTED,
      'surfaces.email.smtp.secure': true,
    })));
    expect(secure.smtpSecurity).toBe('tls');
  });

  test('imap.secure decides the IMAP security mode at both positions', () => {
    // The default: nothing set, TLS, exactly as every IMAP connection behaved
    // before this key was read at all.
    const unset = readSurfaceEmailSettings(reader(NESTED));
    expect(unset.imapSecure).toBe(true);
    expect(readEmailConfig(createSurfaceEmailConfigReader(reader(NESTED))).imapSecurity).toBe('tls');

    // False is the position the schema describes and nothing implemented: a
    // plain IMAP connection, for a server on localhost or in a test.
    const plaintextKeys = { ...NESTED, 'surfaces.email.imap.secure': false };
    expect(readSurfaceEmailSettings(reader(plaintextKeys)).imapSecure).toBe(false);
    expect(
      readEmailConfig(createSurfaceEmailConfigReader(reader(plaintextKeys))).imapSecurity,
    ).toBe('plaintext');

    // Explicit true reads back as TLS, so the key is a real two-value switch and
    // not just an absence check.
    const tlsKeys = { ...NESTED, 'surfaces.email.imap.secure': true };
    expect(
      readEmailConfig(createSurfaceEmailConfigReader(reader(tlsKeys))).imapSecurity,
    ).toBe('tls');
  });

  test('an unreachable imap.secure key stays on the encrypted default', () => {
    const settings = readSurfaceEmailSettings(() => {
      throw new Error('Invalid config path: surfaces.email.imap.secure');
    });
    expect(settings.imapSecure).toBe(true);
  });

  test('a mailbox with no host, account or password is not enabled', () => {
    const config = readEmailConfig(createSurfaceEmailConfigReader(reader({})));
    expect(config.enabled).toBe(false);
    expect(config.imapHost).toBe('');
  });

  test('keys outside the email namespace pass straight through', () => {
    const passthrough = createSurfaceEmailConfigReader(reader({ 'ui.theme': 'dark' }));
    expect(passthrough('ui.theme')).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// Password chains
// ---------------------------------------------------------------------------

describe('mail password resolution', () => {
  test('the shared password is used for both protocols when no SMTP one is stored', async () => {
    const store = createSurfaceEmailSecretReader(secrets({ GOODVIBES_SURFACES_EMAIL_PASSWORD: 'shared-pw' }));
    const config = readEmailConfig(createSurfaceEmailConfigReader(reader(NESTED)));
    expect(await store.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('shared-pw');
    expect(await store.get('GOODVIBES_SURFACES_EMAIL_SMTP_PASSWORD')).toBe('shared-pw');
    expect(smtpPasswordRefFor(config)).toBe(SURFACE_EMAIL_SMTP_PASSWORD_REF);
  });

  test('a stored SMTP password is preferred for submission only', async () => {
    const store = createSurfaceEmailSecretReader(secrets({
      GOODVIBES_SURFACES_EMAIL_PASSWORD: 'shared-pw',
      GOODVIBES_SURFACES_EMAIL_SMTP_PASSWORD: 'submission-pw',
    }));
    expect(await store.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('shared-pw');
    expect(await store.get('GOODVIBES_SURFACES_EMAIL_SMTP_PASSWORD')).toBe('submission-pw');
  });

  test('the shared password falls back to the IMAP-specific secret', async () => {
    const nested = createSurfaceEmailSecretReader(secrets({ GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD: 'imap-pw' }));
    expect(await nested.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('imap-pw');
    expect(await nested.get('GOODVIBES_SURFACES_EMAIL_SMTP_PASSWORD')).toBe('imap-pw');
  });

  test('both spellings of the IMAP password name the same stored secret', () => {
    // `surfaces.email.imap.password` and `surfaces.email.imapPassword` derive
    // one secret name, so a password stored through either spelling resolves.
    expect(daemonSecretKeyFor('surfaces.email.imapPassword')).toBe(
      daemonSecretKeyFor('surfaces.email.imap.password'),
    );
  });

  test('an unrelated secret key is passed through untouched', async () => {
    const store = createSurfaceEmailSecretReader(secrets({ SOMETHING_ELSE: 'value' }));
    expect(await store.get('SOMETHING_ELSE')).toBe('value');
    expect(await store.get('NOT_STORED')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unfinished setup, in the operator's own key names
// ---------------------------------------------------------------------------

describe('unfinished mailbox setup', () => {
  test('missing host or account names the keys the operator actually has', async () => {
    const problem = await describeSurfaceEmailConfigProblem(reader({}), secrets({}));
    expect(problem?.message).toBe(
      'Email is not configured. Set surfaces.email.host, surfaces.email.user, and the email password secret.',
    );
    expect(problem?.code).toBe('EMAIL_NOT_CONFIGURED');
  });

  test('a complete config with no stored password is a credential-store problem', async () => {
    const problem = await describeSurfaceEmailConfigProblem(reader(NESTED), secrets({}));
    expect(problem?.message).toBe('Email password secret is missing from the daemon credential store.');
    expect(problem?.code).toBe('EMAIL_CREDENTIALS_MISSING');
  });

  test('a complete setup reports no problem at all', async () => {
    const problem = await describeSurfaceEmailConfigProblem(
      reader(NESTED),
      secrets({ GOODVIBES_SURFACES_EMAIL_PASSWORD: 'shared-pw' }),
    );
    expect(problem).toBeNull();
  });

  test('the gateway answers with that wording before touching the mailbox', async () => {
    let touched = false;
    const backend: EmailGatewayService = {
      async listInbox() { touched = true; return { messages: [], total: 0 }; },
      async readMessage() { touched = true; return null; },
      async createDraft() { touched = true; throw new Error('unreachable'); },
      async send() { touched = true; throw new Error('unreachable'); },
    };
    const service = createDaemonEmailGatewayService({
      emailGateway: backend,
      describeEmailConfigProblem: () =>
        describeSurfaceEmailConfigProblem(reader(NESTED), secrets({})),
    });
    let thrown: unknown;
    try {
      await service?.listInbox({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayVerbError);
    expect((thrown as GatewayVerbError).message).toBe(
      'Email password secret is missing from the daemon credential store.',
    );
    expect((thrown as GatewayVerbError).code).toBe('EMAIL_CREDENTIALS_MISSING');
    expect((thrown as GatewayVerbError).status).toBe(400);
    expect(touched).toBe(false);
  });

  test('a narrow composition with no mail backend stays unregistered', () => {
    expect(createDaemonEmailGatewayService({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PII-safe logging
// ---------------------------------------------------------------------------

describe('addresses in log fields', () => {
  test('the digest is stable, normalised, and not the address', () => {
    const digest = addressDigest('Mike@Example.com ');
    expect(digest).toBe(addressDigest('mike@example.com'));
    expect(digest).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(digest)).toBe(true);
    expect(digest).not.toContain('mike');
    expect(digest).not.toContain('@');
    expect(addressDigest('someone-else@example.com')).not.toBe(digest);
  });

  test('no raw address reaches a logged field on any mail verb', async () => {
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    const backend: EmailGatewayService = {
      async listInbox() {
        return {
          messages: [
            {
              uid: 7,
              from: 'Jane Doe <jane@example.com>',
              subject: 'Invoice',
              date: '2026-07-27T09:00:00.000Z',
              unread: true,
              bodyPreview: 'reply to sam@example.com',
              messageId: '<abc@example.com>',
            },
          ],
          total: 1,
        };
      },
      async readMessage(uid: number) {
        return {
          uid,
          from: 'Jane Doe <jane@example.com>',
          subject: 'Invoice',
          date: '2026-07-27T09:00:00.000Z',
          messageId: '<abc@example.com>',
          bodyText: 'contact sam@example.com',
          bodyHtml: '<p>contact sam@example.com</p>',
          attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 12 }],
        };
      },
      async createDraft() {
        return { draftId: 'Drafts:9', uid: 9, mailbox: 'Drafts' };
      },
      async send() {
        // A Message-ID is the sending host's identifier for the message, not a
        // person's address, and is logged as itself.
        return { messageId: '<sent-1@relay.invalid>', sentAt: '2026-07-27T09:30:00.000Z' };
      },
    };
    const service = createDaemonEmailGatewayService({
      emailGateway: backend,
      emailLog: (event, fields) => logged.push({ event, fields: { ...fields } }),
    });
    expect(service).not.toBeNull();
    await service?.listInbox({});
    await service?.readMessage(7);
    await service?.createDraft({ to: 'jane@example.com', subject: 'Re', body: 'ok' });
    await service?.send({ to: 'jane@example.com, sam@example.com', subject: 'Re', body: 'ok' });

    expect(logged.map((entry) => entry.event)).toEqual([
      'email.inbox.list',
      'email.inbox.read',
      'email.draft.create',
      'email.send',
    ]);
    const serialised = JSON.stringify(logged);
    for (const address of ['jane@example.com', 'sam@example.com', 'Jane Doe', '@example.com']) {
      expect(serialised).not.toContain(address);
    }
    // The digest is present and IS the digest, the field is populated, not
    // simply omitted, so "no raw address" is not passing by saying nothing.
    expect(logged[1]?.fields['from']).toBe(addressDigest('Jane Doe <jane@example.com>'));
    expect(logged[3]?.fields['recipient']).toBe(addressDigest('jane@example.com, sam@example.com'));
    expect(logged[0]?.fields['senders']).toBe(addressDigest('Jane Doe <jane@example.com>'));
    expect(logged[1]?.fields['hasHtml']).toBe(true);
    expect(logged[1]?.fields['attachments']).toBe(1);
  });

  test('a message id is not an address and is logged as itself', async () => {
    const logged: Record<string, unknown>[] = [];
    const service = createDaemonEmailGatewayService({
      emailGateway: {
        async listInbox() { return { messages: [], total: 0 }; },
        async readMessage() { return null; },
        async createDraft() { return { draftId: 'Drafts', mailbox: 'Drafts' }; },
        async send() { return { messageId: '<sent-1@relay>', sentAt: '2026-07-27T09:30:00.000Z' }; },
      },
      emailLog: (_event, fields) => logged.push({ ...fields }),
    });
    await service?.send({ to: 'jane@example.com', subject: 'Re', body: 'ok' });
    expect(logged[0]?.['messageId']).toBe('<sent-1@relay>');
  });
});

// ---------------------------------------------------------------------------
// Confirmation posture
// ---------------------------------------------------------------------------

describe('a caller that declares this is not a user request', () => {
  // These handlers take the PROCESS ledger by default, which is right in
  // production, one process, one ledger, so a page read and a send are one
  // composition, and is shared state here. Since the fetch tool began
  // recording its reads, any earlier test in the same bun process can leave
  // exposure behind and these sends would be refused for something another
  // file did. Reset rather than pass a private ledger, so what is exercised
  // stays the real production default.
  beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

  const sendService: EmailGatewayService = {
    async listInbox() { return { messages: [], total: 0 }; },
    async readMessage() { return null; },
    async createDraft() { throw new Error('unused'); },
    async send() { return { messageId: '<sent@example.com>', sentAt: '2026-07-27T09:30:00.000Z' }; },
  };

  const calendarService: CalendarGatewayService = {
    async listEvents() { return []; },
    async getEvent() { throw new Error('unused'); },
    async createEvent() { return { eventId: '/a.ics', uid: 'a', createdAt: '2026-07-27T09:30:00.000Z' }; },
    async exportIcs() { return { icsContent: '', eventCount: 0 }; },
    async importIcs() { return { imported: 0, eventIds: [], errors: [] }; },
  };

  const sendBody = { to: 'jane@example.com', subject: 'Hi', body: 'Hello', confirm: true };

  test('email.send is refused when the caller says no person asked', async () => {
    const handler = createEmailSendHandler(sendService);
    let thrown: unknown;
    try {
      await handler({ body: sendBody, context: { metadata: { explicitUserRequest: false } } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayVerbError);
    expect((thrown as GatewayVerbError).code).toBe('EXPLICIT_USER_REQUEST_REQUIRED');
    expect((thrown as GatewayVerbError).status).toBe(403);
  });

  test('email.send proceeds when a person did ask', async () => {
    const handler = createEmailSendHandler(sendService);
    const result = await handler({ body: sendBody, context: { metadata: { explicitUserRequest: true } } });
    expect(result).toEqual({ messageId: '<sent@example.com>', sentAt: '2026-07-27T09:30:00.000Z' });
  });

  test('a transport that carries no claim still gets the confirm gate, and nothing more', async () => {
    const handler = createEmailSendHandler(sendService);
    await expect(handler({ body: { ...sendBody, confirm: false }, context: {} })).rejects.toThrow(
      /cannot be recalled/,
    );
    expect(await handler({ body: sendBody, context: {} })).toEqual({
      messageId: '<sent@example.com>',
      sentAt: '2026-07-27T09:30:00.000Z',
    });
  });

  test('calendar.events.create carries the same posture', async () => {
    const handler = createCalendarEventsCreateHandler(calendarService);
    const body = {
      title: 'Sync',
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T11:00:00Z',
      confirm: true,
    };
    await expect(
      handler({ body, context: { metadata: { explicitUserRequest: false } } }),
    ).rejects.toThrow(/needs an explicit user request/);
    expect(await handler({ body, context: {} })).toEqual({
      eventId: '/a.ics',
      uid: 'a',
      createdAt: '2026-07-27T09:30:00.000Z',
    });
  });
});
