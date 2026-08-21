/**
 * method-catalog-hosted-sessions.ts, the verbs that drive a session whose loop
 * runs INSIDE the daemon.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 * There is no `sessions.hosted.steer`, no `sessions.hosted.cancel`, no
 * `sessions.hosted.queuedMessages.*`. Those verbs exist, `sessions.steer`,
 * `sessions.followUp`, `sessions.toolCalls.cancel`,
 * `sessions.queuedMessages.list/edit/delete`, and they now resolve a hosted
 * session's id the same way they resolve the daemon's local runtime. Minting a
 * parallel family for the same operations is how two spellings of one action
 * drift apart.
 *
 * There is also no token-stream verb, and there does not need to be. The hosted
 * loop is the ordinary Orchestrator, so it emits STREAM_DELTA, tool
 * starts/results and turn transitions on the runtime bus already stamped with
 * the hosted session's id (`createEmitterContext(sessionId, turnId)`), and
 * `GET /api/sessions/:id/events` streams them.
 *
 * That route did NOT always carry all of it. It subscribed on DEFAULT_DOMAINS,
 * which includes `turn` but not `tools`, so a remote renderer received text
 * deltas, turn lifecycle and usage, and no tool call or tool result at all. It
 * also delivered every OTHER session's frames down a path that names one
 * session. Both are fixed at the route (see `openSessionEventStream` in
 * daemon/http/router.ts): it subscribes on RENDER_GRADE_SESSION_DOMAINS, the
 * defaults plus `tools`, and scopes delivery to its own session id.
 *
 * What IS here is the lifecycle nobody could express: bring a hosted session
 * into being, join it, leave it (which is where the detach policy is applied),
 * end it, and list what exists.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** `kill` | `survive`, see the detach descriptor for what each does. */
const DETACH_POLICY_SCHEMA: Record<string, unknown> = { type: 'string', enum: ['kill', 'survive'] };
const HOSTED_SESSION_STATUS_SCHEMA: Record<string, unknown> = { type: 'string', enum: ['idle', 'running', 'terminated'] };
const HISTORY_ROLE_SCHEMA: Record<string, unknown> = { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] };

/** The record every hosted-session verb returns. */
export const HOSTED_SESSION_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  workspaceRoot: STRING_SCHEMA,
  title: STRING_SCHEMA,
  status: HOSTED_SESSION_STATUS_SCHEMA,
  detachPolicy: { anyOf: [DETACH_POLICY_SCHEMA, { type: 'null' }] },
  effectiveDetachPolicy: DETACH_POLICY_SCHEMA,
  attachedClients: arraySchema(STRING_SCHEMA),
  providerId: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  turnCount: NUMBER_SCHEMA,
  messageCount: NUMBER_SCHEMA,
  lastTurnAt: NUMBER_SCHEMA,
  terminatedAt: NUMBER_SCHEMA,
  terminatedReason: STRING_SCHEMA,
  restoredFromDisk: BOOLEAN_SCHEMA,
}, [
  'id', 'workspaceRoot', 'title', 'status', 'detachPolicy', 'effectiveDetachPolicy',
  'attachedClients', 'createdAt', 'updatedAt', 'turnCount', 'messageCount', 'restoredFromDisk',
]);

const HOSTED_SESSION_HISTORY_SCHEMA = arraySchema(objectSchema({
  role: HISTORY_ROLE_SCHEMA,
  content: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
}, ['role', 'content']));

export const builtinGatewayHostedSessionMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'sessions.hosted.create',
    title: 'Create a Daemon-Hosted Session',
    description: 'Compose a full conversation loop INSIDE the daemon for a workspace: the same orchestrator, tool registry and permission gate a terminal runs, hosted here so the conversation does not depend on the client that started it staying open. `workspaceRoot` must be absolute, a relative path would resolve against the daemon\'s own directory, which is never what the caller meant. `modelId` is resolved against this daemon\'s live model registry when given, so an unknown or ambiguous id is refused here rather than at the first turn; omitted, the session follows the daemon\'s current selection. `detachPolicy` overrides the `hostedSessions.detachPolicy` setting for this session alone. `initialPrompt` is submitted as the first user message and the call does NOT wait for that turn, watch the `turn` and `tools` event domains filtered on the returned session id. Refused with the live count and the setting named when `hostedSessions.maxSessions` is already reached. ws-only invoke verb; no REST binding.',
    category: 'sessions',
    transport: ['ws'],
    scopes: ['write:sessions'],
    // Both, honestly: the hosted lifecycle channel, and the broker's own
    // session-update, a hosted session REGISTERS on the shared spine, so it
    // shows up in `sessions.list` alongside every other kind.
    events: ['control.hosted_session_update', 'control.session_update'],
    inputSchema: objectSchema({
      workspaceRoot: STRING_SCHEMA,
      title: STRING_SCHEMA,
      modelId: STRING_SCHEMA,
      initialPrompt: STRING_SCHEMA,
      detachPolicy: DETACH_POLICY_SCHEMA,
      clientId: STRING_SCHEMA,
    }, ['workspaceRoot']),
    outputSchema: objectSchema({ session: HOSTED_SESSION_RECORD_SCHEMA }, ['session']),
  }),
  methodDescriptor({
    id: 'sessions.hosted.attach',
    title: 'Attach to a Daemon-Hosted Session',
    description: 'Join a hosted session and receive its transcript so far, so a client that was never connected, or one reconnecting after the daemon restarted, renders what it missed instead of an empty screen. A session restored from disk has its loop rebuilt on this call, with a system line in the transcript stating that its in-flight turn did not survive the restart. Live output continues on the `turn` and `tools` event domains, filtered on this session id. Attaching is what keeps a `kill`-policy session alive: the policy is applied when the LAST client detaches. An attachment carries a LEASE, `hostedSessions.attachmentTtlMs`, ten minutes by default, or `leaseMs` for this attachment alone, because a client that crashed or closed its tab never calls detach, and a claim nothing expires would hold a kill-policy session open forever. Calling attach again with the same `clientId` renews it, and a client whose control-plane connection is still open renews automatically, so an attached client watching a long turn in silence is never reaped. When the last attachment lapses the session is treated as detached and its policy decides. ws-only invoke verb; no REST binding.',
    category: 'sessions',
    transport: ['ws'],
    scopes: ['write:sessions'],
    // Attaching changes who is watching, not the shared session record, so this
    // drives the hosted lifecycle channel and honestly claims nothing else.
    events: ['control.hosted_session_update'],
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      clientId: STRING_SCHEMA,
      leaseMs: NUMBER_SCHEMA,
    }, ['sessionId', 'clientId']),
    outputSchema: objectSchema({
      session: HOSTED_SESSION_RECORD_SCHEMA,
      history: HOSTED_SESSION_HISTORY_SCHEMA,
    }, ['session', 'history']),
  }),
  methodDescriptor({
    id: 'sessions.hosted.detach',
    title: 'Detach from a Daemon-Hosted Session',
    description: 'Leave a hosted session. When other clients are still attached, nothing else happens. When this was the LAST client, the effective detach policy decides: `kill` (the default, and what closing a client has always done) terminates the session with the reason `detached`; `survive` leaves it idle and reattachable. The policy is the session\'s own override when it was created with one and the `hostedSessions.detachPolicy` setting otherwise, and the returned record says which applied and what the session now is, never a guess by the caller. ws-only invoke verb; no REST binding.',
    category: 'sessions',
    transport: ['ws'],
    scopes: ['write:sessions'],
    // A detach that terminates the session also closes its spine record, but a
    // detach that does not is the common case, so only the channel this verb
    // ALWAYS drives is advertised.
    events: ['control.hosted_session_update'],
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      clientId: STRING_SCHEMA,
    }, ['sessionId', 'clientId']),
    outputSchema: objectSchema({ session: HOSTED_SESSION_RECORD_SCHEMA }, ['session']),
  }),
  methodDescriptor({
    id: 'sessions.hosted.kill',
    title: 'End a Daemon-Hosted Session',
    description: 'End a hosted session regardless of who is attached or what its detach policy says: the in-flight turn is interrupted, its loop is taken apart, its workspace floor is released when it was the last session using it, and the record is kept, terminated, with the reason `killed`, until `hostedSessions.terminatedRetentionMs` retires it. Killing an already-terminated session returns that record unchanged rather than reporting an error for work that is already done. ws-only invoke verb; no REST binding.',
    category: 'sessions',
    transport: ['ws'],
    scopes: ['write:sessions'],
    // Ending one closes its shared-spine record too, so both channels fire.
    events: ['control.hosted_session_update', 'control.session_update'],
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({ session: HOSTED_SESSION_RECORD_SCHEMA }, ['session']),
  }),
  methodDescriptor({
    id: 'sessions.hosted.list',
    title: 'List Daemon-Hosted Sessions',
    description: 'Every session this daemon hosts, most recently updated first. Terminated sessions are excluded unless `includeTerminated` is set, they are kept, with the reason they ended, until the retention window retires them, so a session that stopped can be asked about instead of having simply vanished. Each record carries the policy that would apply on the next detach, so a client can show what leaving will do before it leaves. ws-only invoke verb; no REST binding.',
    category: 'sessions',
    transport: ['ws'],
    scopes: ['read:sessions'],
    inputSchema: objectSchema({ includeTerminated: BOOLEAN_SCHEMA }, []),
    outputSchema: objectSchema({
      sessions: arraySchema(HOSTED_SESSION_RECORD_SCHEMA),
    }, ['sessions']),
  }),
];
