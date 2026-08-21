/**
 * surface-id.ts, naming an inbound surface on the wire without naming it.
 *
 * A "surface" is one inbound consumer identity: a specific Telegram bot, a
 * specific ntfy topic on a specific server, one inbox account. Each of those
 * runs its OWN election, so the datagrams have to say which surface they are
 * about.
 *
 * They say it as a DIGEST, never as the name. An ntfy topic name is not a
 * label, it is a capability: anyone who learns `gv-a8f31c` can read that topic
 * and publish to it, on ntfy.sh, without any other credential. A Telegram bot
 * id is weaker but still identifies the install. Matching works exactly as
 * well on a hash as on the name, the protocol only ever asks "is this the
 * same surface as mine?", never "what is it called", so the name never leaves
 * the process.
 *
 * The digest is deliberately NOT keyed with the group secret. A keyed digest
 * would change every time the group key rotated, which would silently reset
 * every election in the cluster at rotation time: every node would suddenly
 * see a set of surfaces nobody holds and re-elect all of them at once. The
 * digest is a stable matching token; confidentiality of the group's traffic is
 * the signing layer's job, not this function's.
 *
 * The plaintext key stays available LOCALLY as a label for this host's logs and
 * its own `/status`, a topic name in a log file on the machine that already
 * holds the topic's credentials discloses nothing new.
 */
import { createHash } from 'node:crypto';

/** The kinds of inbound surface that can be elected over. */
export type ClusterSurfaceKind =
  | 'telegram'
  | 'ntfy'
  | 'slack'
  | 'discord'
  | 'inbox'
  | 'custom';

/**
 * A surface's LOCAL identity. Never serialized onto the wire, only its digest
 * is. `discriminator` is whatever distinguishes one surface of this kind from
 * another on the same network: a bot id, a server-and-topic pair, an account.
 */
export interface ClusterSurfaceKey {
  readonly kind: ClusterSurfaceKind;
  readonly discriminator: string;
}

/**
 * Domain separation. Prefixed into the hash so a surface digest can never
 * collide with, or be mistaken for, any other digest this codebase computes.
 */
const SURFACE_ID_DOMAIN = 'goodvibes/cluster/surface/v1';

/** 128 bits of a SHA-256, hex. Collision-free at any plausible surface count. */
const SURFACE_ID_HEX_LENGTH = 32;

const SURFACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The exact string that gets hashed.
 *
 * Every node must derive the same digest for the same surface without talking
 * to anyone, so normalization happens HERE and nowhere else: trimmed, and
 * lowercased for the kind only. The discriminator's case is preserved because
 * an ntfy topic is case-sensitive and folding it would merge two real surfaces
 * into one election.
 */
export function canonicalSurfaceKey(key: ClusterSurfaceKey): string {
  return `${String(key.kind).trim().toLowerCase()}:${String(key.discriminator).trim()}`;
}

/** The digest that goes on the wire as `surfaceId`. */
export function surfaceIdFor(key: ClusterSurfaceKey): string {
  return createHash('sha256')
    .update(SURFACE_ID_DOMAIN)
    .update('\u0000')
    .update(canonicalSurfaceKey(key))
    .digest('hex')
    .slice(0, SURFACE_ID_HEX_LENGTH);
}

/** True when `value` is a well-formed surface digest and nothing else. */
export function isSurfaceId(value: unknown): value is string {
  return typeof value === 'string' && SURFACE_ID_PATTERN.test(value);
}

/**
 * A short, human-readable label for local logs and this host's `/status`.
 *
 * Deliberately NOT the full discriminator: a log line wants enough to tell two
 * topics apart, and log files get pasted into issues. The kind is spelled out
 * and the discriminator is reduced to its first eight digest characters.
 */
export function surfaceLabel(key: ClusterSurfaceKey): string {
  return `${key.kind}:${surfaceIdFor(key).slice(0, 8)}`;
}

/**
 * A Telegram bot's public numeric id, taken from its token.
 *
 * A bot token is `<botId>:<secret>`. Only the id half ever reaches this module,
 * and even that is hashed before it is sent, the secret half is never read,
 * never logged, and never hashed.
 */
export function telegramBotIdFromToken(token: string): string {
  const trimmed = String(token ?? '').trim();
  const separator = trimmed.indexOf(':');
  return separator === -1 ? trimmed : trimmed.slice(0, separator);
}

/** The surface for one Telegram bot. */
export function telegramSurface(botIdOrToken: string): ClusterSurfaceKey {
  return { kind: 'telegram', discriminator: telegramBotIdFromToken(botIdOrToken) };
}

/**
 * The surface for ONE ntfy topic on one server.
 *
 * Server and topic together, because the same topic name on two different ntfy
 * servers is two unrelated surfaces, and because a node configured against a
 * self-hosted server must not stand down for a node reading ntfy.sh.
 */
export function ntfySurface(baseUrl: string, topic: string): ClusterSurfaceKey {
  const normalizedBase = String(baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return { kind: 'ntfy', discriminator: `${normalizedBase}/${String(topic ?? '').trim()}` };
}

/** The surface for one inbox provider account (Slack, Discord, an IMAP box). */
export function inboxSurface(providerId: string): ClusterSurfaceKey {
  return { kind: 'inbox', discriminator: String(providerId ?? '').trim() };
}

/** The surface for a single-instance provider runtime (Slack, Discord sockets). */
export function providerSurface(kind: ClusterSurfaceKind, discriminator: string): ClusterSurfaceKey {
  return { kind, discriminator: String(discriminator ?? '').trim() };
}

/**
 * The spread tiebreak: a stable pseudo-random ordering of nodes, DIFFERENT for
 * every surface.
 *
 * Using the nodeId alone as the final tiebreak, as the whole-node design did,
 * hands every surface that reaches the tiebreak to the same node, which is the
 * exact concentration this ranking exists to avoid. Mixing the surface into
 * the hash makes each surface prefer a different node, so a two-node cluster
 * with three surfaces splits them instead of stacking them.
 *
 * It is a hash, not randomness: every node computes the same value for the
 * same pair, forever, with no coordination.
 */
export function stableSurfaceHash(nodeId: string, surfaceId: string): string {
  return createHash('sha256')
    .update('goodvibes/cluster/spread/v1')
    .update('\u0000')
    .update(String(nodeId))
    .update('\u0000')
    .update(String(surfaceId))
    .digest('hex');
}
