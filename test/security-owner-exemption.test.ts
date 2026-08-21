/**
 * security-owner-exemption.test.ts
 *
 * The one exemption to the taint rule: a send whose every recipient is the
 * owner himself.
 *
 * Owner's ruling: he is the trust root, not a third party, and telling him what
 * arrived is the point of an assistant reading his mail. "What came in
 * overnight" is a summary that necessarily reuses the words of what came in, so
 * without this the feature is refused in its most ordinary use.
 *
 * An exemption is a hole by construction, so most of this file is the attacks
 * against it. Each one must fail.
 */

import { describe, expect, test } from 'bun:test';
import {
  OWNER_ADDRESS_CONFIG_KEYS,
  isSendToOwnerOnly,
  resolveOwnerAddresses,
  splitRecipients,
} from '../packages/sdk/src/platform/security/owner-identity.ts';
import {
  UntrustedContentLedger,
  createUntrustedContentPort,
} from '../packages/sdk/src/platform/security/untrusted-content.ts';
import { createEmailSendHandler } from '../packages/sdk/src/platform/control-plane/routes/email.ts';

const OWNER = 'mike@example.com';
const OVERNIGHT = 'the quarterly figures are attached and the board meeting moves to Thursday morning';

function configWith(values: Readonly<Record<string, unknown>>) {
  return (key: string): unknown => values[key];
}

function ledgerHavingMail(text: string): UntrustedContentLedger {
  const ledger = new UntrustedContentLedger();
  const port = createUntrustedContentPort({ surface: 'email', toolName: 'email', ledger });
  port.recordIngest({ origin: 'email:sender.example (claimed)', at: new Date().toISOString(), content: text });
  return ledger;
}

function sendHandler(ledger: UntrustedContentLedger, owners: ReadonlySet<string>) {
  return createEmailSendHandler({
    listInbox: async () => ({ messages: [], total: 0 }),
    readMessage: async () => null,
    createDraft: async () => ({ draftId: 'Drafts', mailbox: 'Drafts' }),
    send: async () => ({ messageId: 'sent-1', sentAt: '2026-07-27T00:00:00.000Z' }),
  }, ledger, owners);
}

describe('the owner identity comes from configuration and nowhere else', () => {
  test('it reads exactly the declared config keys', () => {
    expect([...OWNER_ADDRESS_CONFIG_KEYS]).toEqual([
      'email.fromAddress',
      'email.username',
      'surfaces.email.from',
      'surfaces.email.user',
      'surfaces.email.username',
    ]);
  });

  test('a configured address is found, display-name wrapping and case included', () => {
    const owners = resolveOwnerAddresses(configWith({ 'surfaces.email.from': 'GoodVibes <Mike@Example.COM>' }));
    expect(owners.has(OWNER)).toBe(true);
  });

  test('nothing configured means NO owner identity, so the exemption cannot fire', () => {
    // The correct failure direction: no identity leaves the refusal in force
    // rather than producing a best guess.
    const owners = resolveOwnerAddresses(configWith({}));
    expect(owners.size).toBe(0);
    expect(isSendToOwnerOnly(OWNER, owners)).toBe(false);
  });

  test('a non-address value is not an identity', () => {
    expect(resolveOwnerAddresses(configWith({ 'email.username': 'mike' })).size).toBe(0);
    expect(resolveOwnerAddresses(configWith({ 'email.fromAddress': '' })).size).toBe(0);
  });

  test('an unreadable config section reads as not-configured rather than throwing', () => {
    const owners = resolveOwnerAddresses((key: string) => {
      if (key.startsWith('surfaces.')) throw new Error(`Invalid config path: ${key}`);
      return key === 'email.fromAddress' ? OWNER : undefined;
    });
    expect(owners.has(OWNER)).toBe(true);
  });
});

describe('attacks on the exemption — every one must fail', () => {
  const owners = new Set([OWNER]);

  test('the owner PLUS an attacker is not exempt', () => {
    // The obvious abuse: name him first, slip a second recipient in beside him.
    expect(isSendToOwnerOnly(`${OWNER}, attacker@evil.example`, owners)).toBe(false);
    expect(isSendToOwnerOnly(`attacker@evil.example, ${OWNER}`, owners)).toBe(false);
  });

  test('a colleague on the owner\'s own domain is not exempt', () => {
    // Not a domain rule, a forward to a colleague is a third-party disclosure.
    expect(isSendToOwnerOnly('someone-else@example.com', owners)).toBe(false);
  });

  test('a plus-alias of the owner is not exempt', () => {
    // Not a pattern rule. An alias minted for a signup is not a reporting channel.
    expect(isSendToOwnerOnly('mike+gv-github-com-k3n9x2p4@example.com', owners)).toBe(false);
  });

  test('a lookalike domain is not exempt', () => {
    expect(isSendToOwnerOnly('mike@examp1e.com', owners)).toBe(false);
    expect(isSendToOwnerOnly('mike@example.com.evil.example', owners)).toBe(false);
  });

  test('an empty recipient list is not exempt', () => {
    expect(isSendToOwnerOnly('', owners)).toBe(false);
    expect(isSendToOwnerOnly(undefined, owners)).toBe(false);
    expect(isSendToOwnerOnly(' , ', owners)).toBe(false);
  });

  test('splitRecipients does not treat a multi-recipient string as one opaque value', () => {
    expect(splitRecipients(`${OWNER}, attacker@evil.example`)).toEqual([OWNER, 'attacker@evil.example']);
  });
});

describe('the exemption in the send path', () => {
  test('the overnight summary TO THE OWNER is sent, though it reuses the mail\'s words', () => {
    const ledger = ledgerHavingMail(`Good morning — ${OVERNIGHT}. Regards.`);
    return expect(sendHandler(ledger, new Set([OWNER]))({
      body: { to: OWNER, subject: 'Overnight summary', body: `Overnight: ${OVERNIGHT}.`, confirm: true },
      context: {},
    })).resolves.toMatchObject({ messageId: 'sent-1' });
  });

  test('the SAME summary to a third party is still refused', () => {
    const ledger = ledgerHavingMail(`Good morning — ${OVERNIGHT}. Regards.`);
    return expect(sendHandler(ledger, new Set([OWNER]))({
      body: { to: 'someone@elsewhere.example', subject: 'FYI', body: `Overnight: ${OVERNIGHT}.`, confirm: true },
      context: {},
    })).rejects.toThrow(/derives from content read from/);
  });

  test('the same summary to the owner AND a third party is refused', () => {
    const ledger = ledgerHavingMail(`Good morning — ${OVERNIGHT}. Regards.`);
    return expect(sendHandler(ledger, new Set([OWNER]))({
      body: {
        to: `${OWNER}, someone@elsewhere.example`,
        subject: 'FYI',
        body: `Overnight: ${OVERNIGHT}.`,
        confirm: true,
      },
      context: {},
    })).rejects.toThrow(/derives from content read from/);
  });

  test('with no owner configured, even a send to that address is refused', () => {
    const ledger = ledgerHavingMail(`Good morning — ${OVERNIGHT}. Regards.`);
    return expect(sendHandler(ledger, new Set())({
      body: { to: OWNER, subject: 'Overnight summary', body: `Overnight: ${OVERNIGHT}.`, confirm: true },
      context: {},
    })).rejects.toThrow(/derives from content read from/);
  });

  test('the exemption does not bypass the confirmation gate', () => {
    // It exempts the TAINT rule and nothing else. Everything that guarded a
    // send to the owner before still guards it.
    const ledger = ledgerHavingMail(`Good morning — ${OVERNIGHT}. Regards.`);
    return expect(sendHandler(ledger, new Set([OWNER]))({
      body: { to: OWNER, subject: 'Overnight summary', body: 'anything', confirm: false },
      context: {},
    })).rejects.toThrow(/confirm/i);
  });

  test('the exemption does not bypass an explicit "not a user request"', () => {
    const ledger = ledgerHavingMail(`Good morning — ${OVERNIGHT}. Regards.`);
    return expect(sendHandler(ledger, new Set([OWNER]))({
      body: { to: OWNER, subject: 'x', body: 'y', confirm: true },
      context: { metadata: { explicitUserRequest: false } },
    })).rejects.toThrow();
  });
});
