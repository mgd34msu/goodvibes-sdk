/**
 * The probe's cost, counted on the wire rather than asserted from reading.
 *
 * This existed as two separate probes making three round trips between them on
 * every non-empty connect, a `UID FETCH ... BODY.PEEK[TEXT]` from one and a
 * `FETCH n (UID BODYSTRUCTURE)` / `FETCH n BODY.PEEK[]` pair from the other.
 * Unifying them was supposed to make the connect CHEAPER as well as coherent,
 * and "supposed to" is not a measurement, so the count is pinned here.
 *
 * An empty mailbox must still cost nothing: there is no message to read, and a
 * freshly created signup alias is empty by definition.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { imapMailboxConnectionPort } from '../packages/sdk/src/platform/email/inbound/index.ts';
import {
  makeFakeMailbox,
  openMailboxSocket,
  type FakeMailboxServer,
} from './_helpers/fake-imap-mailbox.ts';

const MAILBOX = 'INBOX';
let server: FakeMailboxServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function fetchCommandsForConnect(
  initial: readonly { uid: number; from: string; subject: string; deliveredTo: string }[],
): Promise<string[]> {
  server = await makeFakeMailbox({ initial: [...initial] });
  const connection = await imapMailboxConnectionPort({
    connect: () => openMailboxSocket(server!.port),
    username: 'watched@example.test',
    password: 'an-app-password',
    mailbox: MAILBOX,
    timeoutMs: 2_000,
  }).open();
  await connection.close();
  return server.commands.filter((line) => /FETCH/i.test(line));
}

describe('connect-time body probe — round-trip cost', () => {
  test('a non-empty mailbox costs exactly two FETCH round trips, one per form', async () => {
    const commands = await fetchCommandsForConnect([{
      uid: 101,
      from: 'sender@example.test',
      subject: 'a',
      deliveredTo: 'watched@example.test',
    }]);

    // TWO, not three. The third was the second probe's `UID FETCH ...
    // BODY.PEEK[TEXT]`, which the UID-addressed body fetch below now covers.
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/FETCH 1 \(UID BODYSTRUCTURE\)/);
    expect(commands[1]).toMatch(/UID FETCH 101 BODY\.PEEK\[\]/);
  });

  test('an empty mailbox costs nothing: there is nothing to read', async () => {
    expect(await fetchCommandsForConnect([])).toEqual([]);
  });
});
