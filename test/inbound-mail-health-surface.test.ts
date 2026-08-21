/**
 * M6, inbound mail reaches the health surface the owner actually reads.
 *
 * `inboundMailStatus()` and `inboundMailHealth()` had exactly one reference
 * each repo-wide: their own definition. `InboundMailHealthEntry` declares
 * `kind: 'email-inbound'`, documented as distinguishing this entry "from a
 * channel's in a mixed list", and there was no mixed list. A watched mailbox
 * reported its state to nothing.
 *
 * The types stay separate: email inbound is not a `ChannelStatusSnapshot`,
 * because its states describe what a watcher is DOING rather than whether a
 * credential is present, and flattening the two would either lie or dilute the
 * channel model. The SURFACE is unified instead, as the discriminated union
 * `kind` was declared for.
 */
import { describe, expect, test } from 'bun:test';
import { createDaemonChannelRouteHandlers } from '../packages/daemon-sdk/src/channel-routes.ts';

const CHANNEL_STATUS = [
  { surface: 'telegram', state: 'ready', enabled: true },
  { surface: 'slack', state: 'unconfigured', enabled: false },
];

const MAIL_HEALTH = {
  kind: 'email-inbound' as const,
  account: 'primary',
  mailbox: 'INBOX',
  state: 'degraded',
  mode: 'polling',
  reason: 'The server does not advertise IDLE, so new mail is found by polling.',
  enabled: true,
};

function handlersWith(inboundMailHealth?: () => typeof MAIL_HEALTH | null) {
  return createDaemonChannelRouteHandlers({
    channelPlugins: { listStatus: async () => CHANNEL_STATUS },
    ...(inboundMailHealth === undefined ? {} : { inboundMailHealth }),
  } as never);
}

async function healthOf(handlers: ReturnType<typeof handlersWith>) {
  const response = await handlers.getChannelStatus();
  return (await (response as Response).json()) as {
    channels: unknown[];
    health: { kind: string }[];
  };
}

describe('the health surface reports channels and inbound mail together', () => {
  test('a watched mailbox appears in the health list', async () => {
    const body = await healthOf(handlersWith(() => MAIL_HEALTH));
    const mail = body.health.find((entry) => entry.kind === 'email-inbound');
    expect(mail).toMatchObject({
      kind: 'email-inbound',
      account: 'primary',
      mailbox: 'INBOX',
      state: 'degraded',
    });
  });

  test('every channel is still there, under its own discriminant', async () => {
    const body = await healthOf(handlersWith(() => MAIL_HEALTH));
    expect(body.health.filter((entry) => entry.kind === 'channel')).toHaveLength(2);
    expect(body.health).toHaveLength(3);
  });

  test('`channels` keeps its exact shape, so nothing consuming it changes', async () => {
    const body = await healthOf(handlersWith(() => MAIL_HEALTH));
    expect(body.channels).toEqual(CHANNEL_STATUS);
  });

  test('a daemon watching no mailbox omits the entry rather than inventing one', async () => {
    // Absent is a different answer from healthy. A composition without the
    // builtin channel runtime has no mailbox to report on, and a green entry
    // there would be the invented-liveness failure this platform keeps finding.
    const body = await healthOf(handlersWith(() => null));
    expect(body.health.some((entry) => entry.kind === 'email-inbound')).toBe(false);
    expect(body.health).toHaveLength(2);
  });

  test('a context that supplies no callback at all is also silent, not green', async () => {
    const body = await healthOf(handlersWith());
    expect(body.health.some((entry) => entry.kind === 'email-inbound')).toBe(false);
  });
});
