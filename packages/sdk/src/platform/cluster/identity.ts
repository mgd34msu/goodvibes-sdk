/**
 * identity.ts, the stable name this install answers to on the LAN.
 *
 * The nodeId has to survive restarts: it is the last ranking tiebreak, and a
 * value that changed every boot would make the tiebreak a coin toss and let a
 * restart loop repeatedly change who is responsible. It also has to be
 * meaningless, it is broadcast in the clear on a LAN, so it carries no
 * hostname, no username, and no path.
 *
 * The file is content-validated on read. A truncated or hand-edited id is not
 * a reason to refuse to start; it is a reason to mint a new one, say so once,
 * and carry on.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClusterLogger } from './types.js';

/** The file, relative to the daemon state directory. */
export const CLUSTER_NODE_ID_FILENAME = 'cluster-node-id';

const NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `value` is a well-formed node id and nothing else. */
export function isValidNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_ID_PATTERN.test(value.trim());
}

export interface ResolveNodeIdOptions {
  /** Daemon state directory; the id file is created inside it. */
  readonly stateDirectory: string;
  readonly logger?: ClusterLogger | undefined;
}

export interface ResolvedNodeIdentity {
  readonly nodeId: string;
  readonly filePath: string;
  /** True when this call minted the id rather than reading an existing one. */
  readonly created: boolean;
  /** Set when an existing file was present but unusable. */
  readonly replacedReason?: string | undefined;
}

/**
 * Read the persisted node id, or mint and persist one.
 *
 * A failure to WRITE is not fatal either: the process gets a usable in-memory
 * id for this run and the reason is logged. Losing identity stability across a
 * restart degrades a tiebreak; refusing to run would take inbound messaging
 * down entirely, which is far worse.
 */
export function resolveNodeIdentity(options: ResolveNodeIdOptions): ResolvedNodeIdentity {
  const filePath = join(options.stateDirectory, CLUSTER_NODE_ID_FILENAME);
  let replacedReason: string | undefined;

  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const wasEmpty = raw.length === 0;
    if (isValidNodeId(raw)) {
      return { nodeId: raw, filePath, created: false };
    }
    replacedReason = wasEmpty
      ? 'the stored node id file was empty'
      : 'the stored node id was not a well-formed identifier';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      replacedReason = `the stored node id could not be read (${code ?? 'unknown error'})`;
    }
  }

  const nodeId = randomUUID();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${nodeId}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    options.logger?.warn('cluster: could not persist the node id; using an in-memory id for this run', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
      impact: 'the nodeId tiebreak will differ after a restart; election correctness is unaffected',
    });
    return {
      nodeId,
      filePath,
      created: true,
      ...(replacedReason ? { replacedReason } : {}),
    };
  }

  if (replacedReason) {
    options.logger?.warn('cluster: minted a replacement node id', { filePath, reason: replacedReason });
  }
  return {
    nodeId,
    filePath,
    created: true,
    ...(replacedReason ? { replacedReason } : {}),
  };
}
