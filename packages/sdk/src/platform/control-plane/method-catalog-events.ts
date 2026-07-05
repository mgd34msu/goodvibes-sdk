import type { GatewayEventDescriptor } from './method-catalog-shared.js';
import { STRING_SCHEMA,NUMBER_SCHEMA,JSON_OBJECT_SCHEMA,arraySchema,objectSchema,eventDescriptor,runtimeDomainEvent } from './method-catalog-shared.js';
import { CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA } from './operator-contract-schemas.js';
import { RUNTIME_EVENT_DOMAINS, type RuntimeEventDomain } from '../../events/domain-map.js';

/**
 * The discriminated `event` values carried inside every `session-update` wire frame.
 *
 * The SharedSessionBroker collapses ALL of its lifecycle signals onto a single wire event
 * named `session-update` (session-broker.ts `publishUpdate`); the real lifecycle name lives
 * in the frame's `payload.event` field. This list is the source of truth for that
 * discriminant and is documented by the `control.session_update` descriptor below so a
 * subscriber (webui/TUI) can switch on `payload.event` against a contract-backed enum
 * instead of guessing from undocumented behavior.
 *
 * NOTE (One-Platform S1 coordination): new broker signals flow through the SAME
 * `session-update` wire channel automatically because `publishUpdate` is generic — when
 * S1's `sessions.register` flow emits e.g. `session-registered`, only THIS enum needs the
 * added string (the wire channel already carries it). Keep this list aligned with the
 * broker's publishUpdate/publishInputLifecycleEvent call sites.
 */
export const SESSION_UPDATE_WIRE_EVENTS = [
  'session-created',
  'session-closed',
  'session-reopened',
  'session-agent-bound',
  'session-agent-completed',
  'session-message-appended',
  'session-message-forwarded',
  'session-route-attached',
  'session-input-queued',
  'session-input-delivered',
  'session-input-spawned',
  'session-input-completed',
  'session-input-failed',
  'session-input-rejected',
  'session-input-cancelled',
  'session-follow-up-queued',
  'session-follow-up-spawned',
] as const;

/**
 * Maps each cross-surface invalidation intent to the concrete `payload.event` value(s) a
 * subscriber must react to. Documented in the descriptor so the webui/TUI do not guess.
 */
export const SESSION_UPDATE_INTENT_MAP = {
  created: ['session-created'],
  updated: ['session-message-appended', 'session-agent-completed', 'session-route-attached', 'session-reopened'],
  steered: ['session-input-delivered', 'session-message-forwarded'],
  closed: ['session-closed'],
} as const satisfies Record<string, readonly (typeof SESSION_UPDATE_WIRE_EVENTS)[number][]>;

const RUNTIME_DOMAIN_DESCRIPTIONS = {
  session: 'Shared-session lifecycle, participant, and message events.',
  turn: 'Turn submission and completion events.',
  providers: 'Provider health, selection, and routing events.',
  tools: 'Tool start, result, and failure events.',
  tasks: 'Runtime task lifecycle and status events.',
  agents: 'Agent lifecycle, planning, and completion events.',
  workflows: 'Workflow orchestration events.',
  orchestration: 'Higher-level orchestration and planner coordination events.',
  communication: 'Agent communication and policy events.',
  planner: 'Planner updates and plan mutation events.',
  permissions: 'Approval and permission prompt events.',
  plugins: 'Plugin registration and lifecycle events.',
  mcp: 'MCP server, tool, and connection events.',
  transport: 'Transport connect, disconnect, and lifecycle events.',
  compaction: 'Context compaction and summary events.',
  ui: 'UI-focused state and operational events.',
  ops: 'Operational diagnostics and control events.',
  forensics: 'Forensics and incident trail events.',
  security: 'Security posture and policy events.',
  automation: 'Automation job, schedule, and run events.',
  routes: 'Route binding and surface-link events.',
  'control-plane': 'Control-plane client, auth, and subscription events.',
  deliveries: 'Delivery queue and outcome events.',
  watchers: 'Watcher state and heartbeat events.',
  surfaces: 'Surface registration and health events.',
  knowledge: 'Knowledge ingest, extraction, projection, packet, and job events.',
  workspace: 'Workspace swap lifecycle events (start, complete, refuse).',
} satisfies Record<RuntimeEventDomain, string>;

export const builtinGatewayEventDescriptors: readonly GatewayEventDescriptor[] = [
  ...RUNTIME_EVENT_DOMAINS.map((domain) => runtimeDomainEvent(domain, RUNTIME_DOMAIN_DESCRIPTIONS[domain])),
  eventDescriptor({
    id: 'control.ready',
    title: 'Ready Handshake',
    description: 'Initial SSE/WebSocket handshake event emitted after a control-plane subscription is opened.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['ready'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      domains: arraySchema(STRING_SCHEMA),
      transport: STRING_SCHEMA,
    }, ['clientId', 'domains', 'transport']),
  }),
  eventDescriptor({
    id: 'control.heartbeat',
    title: 'Heartbeat',
    description: 'Keepalive event emitted by the SSE control-plane transport.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['heartbeat'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      ts: NUMBER_SCHEMA,
    }, ['clientId', 'ts'], { additionalProperties: false }),
  }),
  eventDescriptor({
    id: 'control.surface_message',
    title: 'Surface Message',
    description: 'Out-of-band control-plane surface messages for operators and connected clients.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['surface-message'],
    outputSchema: CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA,
  }),
  eventDescriptor({
    id: 'control.session_update',
    title: 'Session Lifecycle Update',
    description:
      'Shared-session lifecycle broadcast. Every session created / closed / reopened / '
      + 'agent-bound / agent-completed / message-appended / message-forwarded / route-attached '
      + 'and every input & follow-up lifecycle transition is published on the single '
      + '`session-update` wire event; the specific lifecycle name is the discriminated '
      + '`payload.event` field. Cross-surface invalidation mapping (webui/TUI): '
      + 'created ⇐ session-created; updated ⇐ session-message-appended / session-agent-completed / '
      + 'session-route-attached / session-reopened; steered ⇐ session-input-delivered / '
      + 'session-message-forwarded; closed ⇐ session-closed. This channel is un-domained: it '
      + 'reaches every live SSE/WS client regardless of subscribed domains, and is dropped '
      + 'entirely when the control-plane-gateway flag is turned off (no phantom buffering).',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:sessions'],
    wireEvents: ['session-update'],
    outputSchema: objectSchema({
      event: { type: 'string', enum: [...SESSION_UPDATE_WIRE_EVENTS] },
      payload: JSON_OBJECT_SCHEMA,
      createdAt: NUMBER_SCHEMA,
    }, ['event', 'payload', 'createdAt']),
  }),
];
