/**
 * config-replication-policy.ts — which settings may cross the network, and why.
 *
 * This module exists to make one class of mistake IMPOSSIBLE rather than
 * unlikely: replicating a machine-specific value. A replicated
 * `controlPlane.port` would give every node in the group the same port, and the
 * second one to start would fail to bind. That is not hygiene, it is a
 * correctness rule, and the shape of this file follows from it.
 *
 * Three properties hold by construction:
 *
 *  1. The candidate set is DERIVED, never hand-maintained. It comes from the
 *     existing ownership machinery — `listDaemonOwnedConfigPaths()` — so a key
 *     that is not daemon-owned cannot be replicated at all, whatever anyone
 *     writes here. Client and user preferences are therefore out by definition.
 *
 *  2. Replication is FAIL-CLOSED. A daemon-owned key replicates only if it sits
 *     under a domain listed in {@link REPLICATED_CONFIG_DOMAINS}. A new domain
 *     replicates nothing until someone classifies it, and the classification
 *     test refuses a daemon-owned domain that nobody has ruled on.
 *
 *  3. Machine-specific values are excluded STRUCTURALLY as well as by name.
 *     Any setting whose schema marks it a port is refused wherever it lives,
 *     because a port is a property of a machine and never of a group.
 *
 * Secrets follow the config, and are derived the same way: the only secret that
 * replicates is the one a replicated config path names. Nothing else in the
 * secret store — least of all the group's own key material — has a config path
 * that derives its name, so nothing else can be selected.
 *
 * Selection is not the same thing as STORAGE, and the two are deliberately not
 * merged. A replicated credential is by construction daemon-owned
 * (`isDaemonOwnedSecretKey`), so the receiving node files it in its daemon
 * secret tier — one home, read back whatever directory the daemon starts in.
 * The reverse does not hold and must not: the daemon tier is not an export
 * list. A daemon-owned credential replicates only if a REPLICATED path names
 * it, which is why `cluster.*` credentials stay on the machine that made them.
 */
import { CONFIG_SCHEMA } from '../config/schema.js';
import { PORT_VALIDATION_HINT } from '../config/schema-shared.js';
import { listDaemonOwnedConfigPaths } from '../config/config-ownership.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';

/**
 * Daemon-owned domains that describe how the GROUP behaves, and therefore
 * replicate.
 *
 * Each entry is a ruling, and the reason is next to it. "The group should agree
 * on this" is the test; "this machine happens to need this" is not.
 */
export const REPLICATED_CONFIG_DOMAINS: readonly string[] = [
  // Which chat surfaces exist, how they are addressed, and how replies go out.
  // A node that wins a surface must be configured to serve it or the handover
  // is theatre — this is the whole reason replication exists.
  'surfaces.',
  // Whether an inbound message becomes a conversation or a workstream. A group
  // that disagreed about this would answer the same message differently
  // depending on which machine happened to read it.
  'conversationGate.',
  // Scheduled and triggered work the daemon performs on the group's behalf.
  'automation.',
  'checkin.',
  'watchers.',
  // Outbound delivery behaviour: retries, backoff, dead-letter bounds.
  'integrations.',
  // How long the group keeps what it has stored.
  'atRest.',
  // Paired phones belong to the operator, not to one machine.
  'device.',
  // Spending limits belong to the OPERATOR, not to whichever machine is holding
  // the surface. A node that takes over a handover without them would either
  // refuse every purchase or, far worse, fall back to defaults — and the whole
  // safety story here is that a number he set is the number that binds.
  //
  // What crosses the wire is the budget, the windows, the shipping preference
  // and card METADATA (label, brand, last4). Card material is not config: the
  // number, expiry and CVV live in the daemon secret store and replicate, if at
  // all, by the secret path with the rest of the daemon's credentials.
  //
  // KNOWN LIMIT, recorded rather than hidden: this replicates the LIMITS, not
  // the SPEND. Today's totals live in the payments spend ledger, which is not
  // config and does not cross here, so a node that takes over mid-day starts
  // from a clean daily budget and could spend it again. Payments therefore
  // refuse on a node that is not the elected payments leader; see
  // docs/payments.md §5.1. Replicating the ledger itself is the real fix and is
  // not attempted in this round.
  'payments.',
  // The operator's mailbox and calendar belong to the operator, not to the
  // machine that happens to be holding the surface this minute. A node that
  // takes over a handover has to be able to read and send as them, or the
  // handover moves the responsibility without the means to meet it.
  //
  // These are credential pointers, so what crosses the wire is the credential
  // itself: it lands in the receiving node's daemon tier, which is the one
  // home that does not depend on which directory the daemon started in.
  'email.',
  'calendar.',
  'google.oauth.',
  // How the owner profile behaves — whether it is loaded, whether facts are
  // recorded autonomously, whether writes and closed-tier reads are announced,
  // whether the open tier reaches model context, whether unset consumer keys
  // fall back to it. These are decisions about how the platform treats HIM, and
  // a group where one node recorded facts silently while another asked would be
  // the same assistant behaving two different ways depending on which machine
  // answered.
  //
  // What does NOT cross the wire here: the profile document. This replicates
  // the eight policy keys and nothing else; `profile.path` is ruled node-local
  // below because it names a location on one machine's disk.
  'profile.',
];

/**
 * Daemon-owned domains that are properties of a MACHINE, listed so the
 * classification test can prove every daemon-owned domain was ruled on rather
 * than merely omitted.
 *
 * These are the ones that would break a real install if they crossed the wire.
 */
export const NODE_LOCAL_CONFIG_DOMAINS: readonly string[] = [
  // The address and port this machine serves its control plane on. Replicating
  // it is the port collision described at the top of this file.
  'controlPlane.',
  'httpListener.',
  // Where this machine's web UI is served from and reachable at.
  'web.',
  // This machine's relay identity and its registration with one.
  'relay.',
  // Cluster transport identity and participation: whether THIS machine takes
  // part, which port and multicast group it coordinates on, which static peers
  // it can reach, and the shared phrase it signs with. Replicating any of these
  // would either partition the group mid-flight or switch a machine on that the
  // operator deliberately left off.
  'cluster.',
  // Local voice provisioning: model files on this machine's disk.
  'voice.local.',
];

/** Individual daemon-owned keys that are machine-specific despite their domain. */
const NODE_LOCAL_CONFIG_KEYS: readonly string[] = [
  // Whether THIS installation exposes a raw HTTP listener at all.
  'danger.httpListener',
  // Where the owner profile file lives on THIS machine. The rest of `profile.*`
  // replicates (it is policy about the operator); this one is a filesystem path,
  // and copying it to a node whose daemon home is elsewhere would point that
  // node at a file that does not exist there.
  'profile.path',
  // "This machine has already read the legacy plaintext credential files that
  // were sitting in its own home directory." It is a statement about one
  // filesystem, not about the group: another node has its own home directory,
  // may well have its own stranded copy of those files, and needs to make its
  // own pass. Replicating the marker would tell it the work was done and leave
  // the credentials sitting in the clear where nobody looks again.
  'google.credentials.migratedFrom',
];

/** Why a daemon-owned path is or is not replicated. */
export type ConfigReplicationClass = 'replicated' | 'node-local';

export interface ConfigPathClassification {
  readonly path: string;
  readonly replication: ConfigReplicationClass;
  /** Plain-language reason, surfaced by the classification test on failure. */
  readonly reason: string;
}

const portKeyCache = new Set<string>(
  CONFIG_SCHEMA
    .filter((setting) => setting.validationHint === PORT_VALIDATION_HINT)
    .map((setting) => setting.key),
);

/** True when the schema marks this key a port. Ports never replicate. */
export function isPortConfigKey(path: string): boolean {
  return portKeyCache.has(path);
}

function underAny(path: string, domains: readonly string[]): boolean {
  return domains.some((domain) => path.startsWith(domain));
}

/**
 * Classify one daemon-owned path.
 *
 * Order matters: the structural port check runs FIRST, so a port that someone
 * later adds inside a replicated domain is still refused without anyone having
 * to remember to list it.
 */
/**
 * Daemon-owned keys ruled on individually because their DOMAIN goes the other
 * way.
 */
export const REPLICATED_CONFIG_KEYS: readonly string[] = [
  // `daemon.*` is otherwise node-local — it answers "does THIS machine run a
  // daemon". The timezone answers where the operator is, and the group has to
  // agree on it: the payment capability rolls its daily budgets over at
  // midnight in this zone, so two nodes on different zones would disagree about
  // what day it is. A handover across that disagreement either hands back a
  // fresh daily budget or retroactively overspends one, and neither is visible
  // to the operator, who set one zone and was shown one zone.
  'daemon.timezone',
];

export function classifyDaemonConfigPath(path: string): ConfigPathClassification {
  if (REPLICATED_CONFIG_KEYS.includes(path)) {
    return { path, replication: 'replicated', reason: 'the group must agree on what day it is' };
  }
  if (isPortConfigKey(path)) {
    return { path, replication: 'node-local', reason: 'the schema marks this a port, and a port belongs to a machine' };
  }
  if (NODE_LOCAL_CONFIG_KEYS.includes(path)) {
    return { path, replication: 'node-local', reason: 'this switch is a property of this installation' };
  }
  if (underAny(path, NODE_LOCAL_CONFIG_DOMAINS)) {
    return { path, replication: 'node-local', reason: 'this domain describes one machine, not the group' };
  }
  if (underAny(path, REPLICATED_CONFIG_DOMAINS)) {
    return { path, replication: 'replicated', reason: 'the group should agree on this' };
  }
  // Fail closed. A daemon-owned domain nobody has ruled on stays local.
  return { path, replication: 'node-local', reason: 'no ruling has been made about this domain, so it stays local' };
}

/**
 * True when `path` may cross the network.
 *
 * The daemon-ownership check is not redundant with the domain check: it is what
 * makes a client or user preference unreachable from here no matter what the
 * domain lists say.
 */
export function isReplicatedConfigPath(path: string): boolean {
  if (!daemonOwnedPathSet().has(path)) return false;
  return classifyDaemonConfigPath(path).replication === 'replicated';
}

let daemonOwnedSet: Set<string> | null = null;

function daemonOwnedPathSet(): Set<string> {
  daemonOwnedSet ??= new Set<string>(listDaemonOwnedConfigPaths());
  return daemonOwnedSet;
}

let replicatedPathCache: readonly string[] | null = null;

/** Every config path that replicates, in schema order. */
export function listReplicatedConfigPaths(): readonly string[] {
  replicatedPathCache ??= listDaemonOwnedConfigPaths().filter((path) => isReplicatedConfigPath(path));
  return replicatedPathCache;
}

/** Every daemon-owned path with its ruling. Used by the classification test. */
export function listDaemonConfigClassifications(): readonly ConfigPathClassification[] {
  return listDaemonOwnedConfigPaths().map((path) => classifyDaemonConfigPath(path));
}

// ── secrets ─────────────────────────────────────────────────────────────────

/**
 * The secret-store name a config path implies.
 *
 * One implementation, in the config layer (`daemonSecretKeyFor`), because the
 * same derivation decides two things that must agree: which credential a
 * replicated path names, and which credential the daemon owns and therefore
 * stores in its own tier. This used to be a second copy of the rule, and a
 * second copy is a drift waiting to happen.
 */
export function replicatedSecretKeyFor(configPath: string): string {
  return daemonSecretKeyFor(configPath);
}

let replicatedSecretCache: ReadonlyMap<string, string> | null = null;

/** Secret-store name → the replicated config path that named it. */
export function replicatedSecretKeys(): ReadonlyMap<string, string> {
  if (!replicatedSecretCache) {
    const map = new Map<string, string>();
    for (const path of listReplicatedConfigPaths()) map.set(replicatedSecretKeyFor(path), path);
    replicatedSecretCache = map;
  }
  return replicatedSecretCache;
}

/**
 * True when this secret-store key may cross the network.
 *
 * The group's own key material can never satisfy this: `cluster.` is
 * node-local, so no replicated config path derives `GOODVIBES_CLUSTER_*`, and a
 * secret nothing derives is a secret nothing can select.
 */
export function isReplicatedSecretKey(secretKey: string): boolean {
  return replicatedSecretKeys().has(secretKey);
}
