/**
 * companion-chat-turn-boundary.test.ts, the webui gets a turn boundary too,
 * and only where the daemon can prove who is speaking.
 *
 * ── Why this surface needed its own wiring ────────────────────────────────
 *
 * `CompanionChatManager` runs its own turn loop rather than the Orchestrator's,
 * so the boundary wired into `Orchestrator.runTurn`, the one that fixed the
 * agent and the TUI together, did not reach it. The consequence was narrow and
 * bad: a message the owner typed in the webui never ended the previous turn's
 * untrusted-content window, so the friction removed everywhere else stayed
 * present on one of his three surfaces, and a page read an hour earlier still
 * counted against a message he was writing now.
 *
 * ── The rule this file pins ───────────────────────────────────────────────
 *
 * Attest only what you can prove. Three transports reach this manager and they
 * are not alike:
 *
 *  - The HTTP route (`POST /api/companion/chat/sessions/:id/messages`) sits
 *    behind the daemon's bearer-token auth. Holding that token IS being the
 *    owner, same credential the TUI and operator API use, so it attests, and
 *    the window resets.
 *  - The ntfy relay carries a topic. Anyone who learns the topic can publish to
 *    it, so it attests nothing and the window stays open.
 *  - Home Assistant carries a device id. A voice pipeline reports which speaker
 *    heard something, never who spoke, so it attests nothing either.
 *
 * The failure this asymmetry prevents is specific: a transport that could reset
 * the window on a stranger's message would let content that had just been read
 * erase the record of itself before the outward action it was trying to cause.
 * So "cannot tell" resolves to "not the owner", every time, and the cost of
 * being wrong in that direction is friction rather than a send.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getProcessUntrustedContentLedger,
  resetProcessUntrustedContentLedgerForTests,
} from '../packages/sdk/src/platform/security/untrusted-content.ts';
import { startTurnForOwnerInput } from '../packages/sdk/src/platform/security/turn-boundary.ts';

/**
 * The turn-start funnel's boundary call, as the manager makes it.
 *
 * `_startNextTurn` reads `next.ownerDirect` off the queued entry and calls
 * exactly this. Reproducing that one line keeps the test on the CONTRACT,
 * "an attested turn resets, an unattested one does not", without standing up
 * a provider, a conversation store and a session persister to observe it.
 * The end of this file checks the manager really is wired this way.
 */
function startCompanionTurn(ownerDirect: boolean | undefined): boolean {
  return startTurnForOwnerInput({ ownerDirect: ownerDirect === true });
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

describe('an authenticated owner message ends the previous turn', () => {
  test('the webui route attests, and the window resets', () => {
    recordAPageRead();
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);

    // What companion-chat-routes.ts passes: ownerDirect: true.
    expect(startCompanionTurn(true)).toBe(true);
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(false);
  });

  test('a second webui message carries nothing from the first', () => {
    startCompanionTurn(true);
    recordAPageRead();
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);

    startCompanionTurn(true);
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(false);
  });
});

describe('a relayed message does not', () => {
  test('the ntfy relay attests nothing, so the window stays open', () => {
    recordAPageRead();
    // What surface-actions.ts passes: nothing at all.
    expect(startCompanionTurn(undefined)).toBe(false);
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);
  });

  test('Home Assistant attests nothing either — a room is not a person', () => {
    recordAPageRead();
    expect(startCompanionTurn(undefined)).toBe(false);
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);
  });

  test('an explicit false is honoured over anything else', () => {
    recordAPageRead();
    expect(startCompanionTurn(false)).toBe(false);
    expect(getProcessUntrustedContentLedger().hasIngestedThisTurn()).toBe(true);
  });
});

describe('the wiring itself, so this cannot pass while the manager forgets', () => {
  /**
   * The defect class being guarded here is a call site that does not exist,
   * which is what produced the original bug. Behavioural tests above cannot
   * catch it: they exercise the boundary, not the manager's use of it. So the
   * manager's source is read, the same way the workspace-card parity test reads
   * the command file it is checking against.
   */
  test('the turn-start funnel opens the boundary from the queued entry', async () => {
    const source = await Bun.file(
      new URL('../packages/sdk/src/platform/companion/companion-chat-manager.ts', import.meta.url),
    ).text();

    const funnel = source.slice(source.indexOf('private _startNextTurn('));
    const body = funnel.slice(0, funnel.indexOf('\n  private '));

    expect(body).toContain('startTurnForOwnerInput');
    // Read off the QUEUED entry, not from ambient state: a message can wait
    // behind an active turn, and by then the call that knew who sent it is gone.
    expect(body).toContain('next.ownerDirect');
  });

  test('only the authenticated route attests', async () => {
    const routes = await Bun.file(
      new URL('../packages/sdk/src/platform/companion/companion-chat-routes.ts', import.meta.url),
    ).text();
    expect(routes).toContain('ownerDirect: true');

    // The two relays must not. If either grows an attestation, a stranger's
    // channel message gains the ability to end the owner's turn.
    for (const relative of [
      '../packages/sdk/src/platform/daemon/surface-actions.ts',
      '../packages/sdk/src/platform/daemon/homeassistant-chat.ts',
    ]) {
      const relay = await Bun.file(new URL(relative, import.meta.url)).text();
      expect(relay).not.toContain('ownerDirect: true');
    }
  });
});
