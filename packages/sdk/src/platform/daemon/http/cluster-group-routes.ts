/**
 * cluster-group-routes.ts — the daemon verbs for LAN group membership.
 *
 * These ARE the feature's interface. The `cluster` CLI subcommands, the TUI's
 * `/cluster` command and any web UI all call these and render what comes back;
 * none of them contains logic of its own. That is what makes `cluster status`
 * against a daemon on another machine behave exactly like running it on that
 * machine.
 *
 * Every verb returns the operation layer's structured result verbatim. Nothing
 * here formats text, and nothing here decides what an operator should see —
 * `--json` and the human rendering are two views of the same bytes rather than
 * two code paths that drift.
 */
import type {
  CreateGroupResult,
  ForgetNodeResult,
  GroupOperationResult,
  GroupStatusReport,
  JoinGroupResult,
  JoinKeyResult,
  NodesResult,
} from '../../cluster/group-operations.js';
import type { DiscoveredGroup } from '../../cluster/group-runtime.js';

/** What the daemon facade supplies. One method per verb, no more. */
export interface ClusterGroupVerbs {
  status(): Promise<GroupOperationResult<GroupStatusReport>> | GroupOperationResult<GroupStatusReport>;
  create(input: { name?: string; passphrase?: string }): Promise<GroupOperationResult<CreateGroupResult>>;
  join(input: { groupId: string; joinKey: string }): Promise<GroupOperationResult<JoinGroupResult>>;
  key(): Promise<GroupOperationResult<JoinKeyResult>> | GroupOperationResult<JoinKeyResult>;
  nodes(): Promise<GroupOperationResult<NodesResult>> | GroupOperationResult<NodesResult>;
  groups(): Promise<GroupOperationResult<readonly DiscoveredGroup[]>> | GroupOperationResult<readonly DiscoveredGroup[]>;
  forget(nodeId: string): Promise<GroupOperationResult<ForgetNodeResult>>;
  leave(): Promise<GroupOperationResult<{ groupId: string; groupName: string }>>;
  rename(name: string): Promise<GroupOperationResult<{ groupId: string; groupName: string }>>;
}

/** The router services this dispatcher needs. */
export interface ClusterGroupRouteContext {
  readonly verbs: ClusterGroupVerbs;
  /** Non-null means refuse — the daemon's own admin check, unchanged. */
  requireAdmin(request: Request): Response | null;
  parseJsonBody(request: Request): Promise<Record<string, unknown> | Response>;
}

/**
 * The dispatcher the router adds to its extension list.
 *
 * A factory rather than an inline closure in the router, so that wiring a new
 * route family costs the router one line. `getVerbs` is read on every request
 * because the LAN group runtime is composed by the HOST, after the router
 * exists — and when it returns null, `/api/cluster/*` is simply unrouted, which
 * is the honest answer for an embedder that composed no group runtime.
 */
export function clusterGroupRouteExtension(
  getVerbs: () => ClusterGroupVerbs | null,
  host: Pick<ClusterGroupRouteContext, 'requireAdmin' | 'parseJsonBody'>,
): (request: Request) => Promise<Response | null> {
  return (request) => {
    const verbs = getVerbs();
    if (!verbs) return Promise.resolve(null);
    return dispatchClusterGroupRoutes(request, {
      verbs,
      requireAdmin: (candidate) => host.requireAdmin(candidate),
      parseJsonBody: (candidate) => host.parseJsonBody(candidate),
    });
  };
}

/**
 * A refusal is a 409, not a 500.
 *
 * "This machine is not in a group" and "that machine is not a member" are
 * ordinary answers to a reasonable question, not faults. They carry the same
 * `error`/`fix` pair the operation layer produced so the CLI can print the fix
 * without having to invent one.
 */
function respond<T>(result: GroupOperationResult<T>): Response {
  if (result.ok) return Response.json({ ok: true, data: result.data });
  return Response.json({ ok: false, error: result.error, fix: result.fix }, { status: 409 });
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Route a request against the cluster verbs.
 *
 * Returns null when the path is not one of these, so it composes with the rest
 * of the daemon's dispatchers without shadowing anything.
 */
export async function dispatchClusterGroupRoutes(
  request: Request,
  context: ClusterGroupRouteContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/cluster/')) return null;

  const denied = context.requireAdmin(request);
  if (denied) return denied;

  const method = request.method.toUpperCase();
  const { verbs } = context;

  if (method === 'GET') {
    switch (path) {
      case '/api/cluster/status':
        return respond(await verbs.status());
      case '/api/cluster/key':
        return respond(await verbs.key());
      case '/api/cluster/nodes':
        return respond(await verbs.nodes());
      case '/api/cluster/groups':
        return respond(await verbs.groups());
      default:
        return null;
    }
  }
  if (method !== 'POST') return null;

  switch (path) {
    case '/api/cluster/create': {
      const body = await context.parseJsonBody(request);
      if (body instanceof Response) return body;
      return respond(await verbs.create({
        ...(readString(body, 'name') !== undefined ? { name: readString(body, 'name') as string } : {}),
        ...(readString(body, 'passphrase') !== undefined
          ? { passphrase: readString(body, 'passphrase') as string }
          : {}),
      }));
    }
    case '/api/cluster/join': {
      const body = await context.parseJsonBody(request);
      if (body instanceof Response) return body;
      const groupId = readString(body, 'groupId');
      const joinKey = readString(body, 'joinKey');
      if (!groupId || !joinKey) {
        return Response.json(
          {
            ok: false,
            error: 'a group id and a join key are both required',
            fix: 'run `cluster join` with no arguments to pick a group from this network, or pass --group and --key',
          },
          { status: 400 },
        );
      }
      return respond(await verbs.join({ groupId, joinKey }));
    }
    case '/api/cluster/forget': {
      const body = await context.parseJsonBody(request);
      if (body instanceof Response) return body;
      const nodeId = readString(body, 'nodeId');
      if (!nodeId) {
        return Response.json(
          {
            ok: false,
            error: 'no machine was named',
            fix: 'run `cluster nodes` to see the member list, then `cluster forget <node>`',
          },
          { status: 400 },
        );
      }
      return respond(await verbs.forget(nodeId));
    }
    case '/api/cluster/rename': {
      const body = await context.parseJsonBody(request);
      if (body instanceof Response) return body;
      const name = readString(body, 'name');
      if (!name) {
        return Response.json(
          { ok: false, error: 'no name was given', fix: 'pass the new name: `cluster rename "<name>"`' },
          { status: 400 },
        );
      }
      return respond(await verbs.rename(name));
    }
    case '/api/cluster/leave':
      return respond(await verbs.leave());
    default:
      return null;
  }
}
