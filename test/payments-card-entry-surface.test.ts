/**
 * payments-card-entry-surface.test.ts
 *
 * Owner ruling: card details are accepted ONLY at a local terminal — the TUI
 * and the agent's own terminal — plus the webui, which is his own browser
 * client over his own LAN rather than a third-party message store. Never over
 * Telegram, ntfy, Discord, Slack, WhatsApp, Signal, a webhook, or any other
 * remote messaging surface.
 *
 * His reasoning is concrete: a card number typed into Telegram is stored on
 * Telegram's servers, in history we cannot reach or erase, and it travelled
 * through their infrastructure before reaching us. Encryption at rest does not
 * apply to a value already copied somewhere else.
 *
 * The distinction these tests protect, which a later round will try to
 * collapse: remote channels DO have authority to approve or veto a purchase.
 * They have no path for entering the instrument.
 *
 * Every value here is an obviously-fake fixture.
 */
import { describe, test, expect } from 'bun:test';
import {
  evaluateCardEntry,
  mayEnterCardDetails,
  mayOfferCardEntryFlow,
  scanForCardDetails,
  describeCardEntryRefusal,
} from '../packages/sdk/src/platform/payments/entry-surface.js';
import { parseCommandAuthorityChannel } from '../packages/sdk/src/platform/payments/types.js';

const FIXTURE_PAN = '4242424242424242';
const FIXTURE_PAN_SPACED = '4242 4242 4242 4242';

describe('entering and approving are different questions', () => {
  test('a local terminal may take card details', () => {
    expect(mayEnterCardDetails('tui')).toBe(true);
    expect(mayEnterCardDetails('agent-terminal')).toBe(true);
    expect(mayEnterCardDetails('webui')).toBe(true);
  });

  test.each(['telegram', 'ntfy', 'discord', 'slack', 'whatsapp', 'signal', 'webhook', 'email', 'sms'])(
    'a remote messaging surface may not: %s',
    (surface) => {
      expect(mayEnterCardDetails(surface)).toBe(false);
      expect(mayOfferCardEntryFlow(surface)).toBe(false);
    },
  );

  test('an unknown surface is refused rather than allowed', () => {
    // Allowlist, not denylist: a channel added next year is refused until
    // someone decides otherwise, which is the safe direction for card material.
    expect(mayEnterCardDetails('some-new-chat-app')).toBe(false);
  });

  test('Telegram still has authority to APPROVE a purchase', () => {
    // The ruling that remote channels can answer approvals and vetoes stands.
    // If this ever fails, the two axes have been wrongly merged.
    expect(parseCommandAuthorityChannel('telegram')).toBe('telegram');
    expect(mayEnterCardDetails('telegram')).toBe(false);
  });
});

describe('card details arriving on a remote channel are refused', () => {
  test('a plausible card number is refused and never stored', () => {
    const decision = evaluateCardEntry({ surface: 'telegram', text: `my card is ${FIXTURE_PAN}` });
    expect(decision.allowed).toBe(false);
    expect(decision.matched).toContain('card-number');
    expect(decision.reason).not.toBeNull();
  });

  test('a spaced card number is caught too', () => {
    const decision = evaluateCardEntry({ surface: 'telegram', text: FIXTURE_PAN_SPACED });
    expect(decision.matched).toContain('card-number');
  });

  test('an expiry pattern is caught', () => {
    expect(scanForCardDetails('12/34').matched).toContain('expiry');
  });

  test('a bare CVV is caught only when one was just asked for', () => {
    // A three-digit message means nothing out of context, and refusing every
    // one of them would make the channel unusable.
    expect(scanForCardDetails('123').looksLikeCardDetails).toBe(false);
    expect(scanForCardDetails('123', { expectingCvv: true }).matched).toContain('cvv');
  });

  test('THE REFUSAL DOES NOT ECHO THE DIGITS', () => {
    // The refusal is delivered over the same channel that stored the message.
    // Quoting the value — even masked — would write it there a second time.
    const decision = evaluateCardEntry({ surface: 'telegram', text: `card ${FIXTURE_PAN} exp 12/34` });
    const reply = decision.reason ?? '';
    expect(reply).not.toContain(FIXTURE_PAN);
    expect(reply).not.toContain('4242');
    expect(reply).not.toContain('12/34');
    expect(reply).not.toMatch(/\d{4}/);
    expect(reply).toContain('telegram');
    expect(reply).toContain('terminal');
  });

  test('the scan reports shapes, never the matching text', () => {
    const scan = scanForCardDetails(`${FIXTURE_PAN} 12/34`);
    expect(JSON.stringify(scan)).not.toContain(FIXTURE_PAN);
    expect(JSON.stringify(scan)).not.toContain('4242');
  });

  test('the refusal tells him to delete the message and treat the card as exposed', () => {
    const reply = describeCardEntryRefusal('telegram');
    expect(reply).toContain('delete');
    expect(reply).toContain('exposed');
  });

  test('an ordinary remote message is not treated as a refused card entry', () => {
    const decision = evaluateCardEntry({ surface: 'telegram', text: 'what did the daemon do overnight?' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeNull();
    expect(decision.matched).toEqual([]);
  });

  test('the same card details at a terminal are accepted', () => {
    const decision = evaluateCardEntry({ surface: 'tui', text: FIXTURE_PAN });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
  });
});
