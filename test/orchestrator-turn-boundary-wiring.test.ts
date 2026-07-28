/**
 * orchestrator-turn-boundary-wiring.test.ts — the call site exists.
 *
 * ── Why this is a file of its own ─────────────────────────────────────────
 *
 * The defect this guards was not a wrong answer from a function. Every piece
 * worked: the ledger had a watermark, `startTurn` moved it, and
 * `startTurnForOwnerRequest` wrapped it correctly. What was missing was anyone
 * calling it on the path where a person actually speaks — so "this turn" meant
 * "since the process started", one mailbox read refused every outward action
 * until restart, and the only cure the owner found was a new session.
 *
 * Unit tests of the boundary all passed throughout. They would pass again if
 * the call were removed tomorrow, because a missing call site is by definition
 * somewhere other than the code under test. So this asserts the WIRING: that
 * driving a turn through the real `Orchestrator` moves the real process ledger.
 *
 * ── Why it reaches for a private method ───────────────────────────────────
 *
 * `runTurn` is where the boundary belongs — `handleUserInput` delegates to it,
 * and so does the queue drain, so a message that waited while the model was
 * thinking still gets its own turn. Constructing a full Orchestrator needs six
 * or more collaborators that have nothing to do with this, so the file follows
 * the house pattern from orchestrator-turn-injections-accessor.test.ts and
 * builds a bare instance over the real prototype. The turn runs until it hits
 * the config lookup and throws; the boundary is deliberately ahead of that, so
 * what is asserted is the state it left behind.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Orchestrator } from '../packages/sdk/src/platform/core/orchestrator.js';
import {
  getProcessUntrustedContentLedger,
  resetProcessUntrustedContentLedgerForTests,
} from '../packages/sdk/src/platform/security/untrusted-content.ts';

type RunTurn = (
  text: string,
  content?: unknown,
  options?: { readonly origin?: { readonly source?: string; readonly ownerDirect?: boolean } },
) => Promise<void>;

/** The real class, over the real prototype, with nothing it does not need. */
function bareOrchestrator(): { runTurn: RunTurn } {
  const orchestrator = Object.create(Orchestrator.prototype) as { runTurn: RunTurn };
  return orchestrator;
}

/**
 * Drive one turn and swallow the failure that follows the boundary.
 *
 * The throw is expected and is not what is under test: it comes from the
 * config lookup a bare instance cannot satisfy. If the boundary ever moves back
 * behind that lookup, these assertions fail — which is the point, because a
 * turn the owner started is his turn whether or not a model can be resolved.
 */
async function driveTurn(origin?: { readonly source?: string; readonly ownerDirect?: boolean }): Promise<void> {
  const orchestrator = bareOrchestrator();
  try {
    await orchestrator.runTurn('do the thing', undefined, origin === undefined ? undefined : { origin });
  } catch {
    // expected; see above.
  }
}

function recordAPageRead(): void {
  getProcessUntrustedContentLedger().record({
    surface: 'web-page',
    origin: 'https://news.example',
    at: new Date().toISOString(),
    content: 'text a stranger published',
  });
}

beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });
afterEach(() => { resetProcessUntrustedContentLedgerForTests(); });

describe('driving a turn through the real Orchestrator moves the real ledger', () => {
  test('an owner turn ends the previous turn\'s exposure', async () => {
    recordAPageRead();
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);

    // No origin: the surface took this text off its own input widget.
    await driveTurn();

    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(false);
  });

  test('a second owner turn carries nothing from the first', async () => {
    await driveTurn();
    recordAPageRead();
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);

    // This is the reported bug stated as a test: the owner types again, and
    // what the agent read for his previous request stops being evidence
    // against what he asks for now.
    await driveTurn();
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(false);
  });

  test('a channel-driven turn leaves the window open', async () => {
    recordAPageRead();

    // The asymmetry is the safe direction and it is the point: if automated
    // work reset the window, content that had just been read could arrange for
    // the record of itself to be erased before the send it was trying to cause.
    await driveTurn({ source: 'ntfy-chat' });

    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);
  });

  test('an unrecognised source leaves it open too', async () => {
    recordAPageRead();
    await driveTurn({ source: 'some-transport-added-next-quarter' });
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);
  });

  test('a transport that can attest the owner sent it does end the turn', async () => {
    recordAPageRead();

    // The escape hatch for a transport that authenticated him — the webui's
    // chat POST is the case this exists for. It is a claim made by code about
    // the caller; no message body constructs one of these.
    await driveTurn({ source: 'companion-followup', ownerDirect: true });

    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(false);
  });
});
