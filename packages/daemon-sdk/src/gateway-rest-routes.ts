import type { DaemonGatewayRestRouteHandlers } from './context.js';

/**
 * gateway-rest-routes.ts
 *
 * Explicit REST route table for the handler-backed gateway verb families that
 * ALSO advertise an `http` binding in the operator method catalog (skills.*,
 * principals.*, profile.*, occasions.*, checkin.*, ci.*, channels.profiles.*, the session-scoped
 * sessions.permissionMode.get/set + sessions.contextUsage.get, stepup.* (the
 * relay step-up ceremony), and runtime.metrics.get). Those verbs are
 * served in-process through `invokeGatewayMethodCall`'s registered-handler
 * branch, reachable over the wire via the generic
 * `POST /api/control/gateway-methods/:methodId/invoke` endpoint. But each one
 * also promises a plain-REST path (`GET /api/skills`, …) in its descriptor's
 * http binding, and no route ever served those paths — a caller trusting the
 * advertisement and hitting `GET /api/skills` got a bare 404. That is the exact
 * advertise-without-route defect the capability-route reconcile
 * (method-catalog-route-reconcile.ts) exists to catch.
 *
 * This module closes that gap with genuine route parity rather than by muting
 * the gate: it maps each advertised REST path to its gateway methodId and
 * dispatches through `handlers.invokeGatewayRestVerb`, which the daemon wires
 * back to the SAME `invokeGatewayMethodCall` the methodId-invoke endpoint uses.
 * No verb logic is duplicated — the REST path and the methodId-invoke endpoint
 * now resolve to the identical in-process handler, with the identical
 * access/scope gate. Path parameters ({name}, {sessionId}, …) are folded into
 * the invocation query so the handler's `readInvocationParams` view sees them.
 *
 * Drift guard: the reconcile gate reddens whenever a handler-backed family
 * gains an http binding without a matching entry here (its advertised path
 * would resolve to no route), so a new family's REST paths must be added to
 * GATEWAY_REST_ROUTES in the same change.
 */

interface GatewayRestRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly methodId: string;
}

/** Build a route entry from an `/api/{param}/...`-style template. */
function route(method: string, template: string, methodId: string): GatewayRestRoute {
  const paramNames: string[] = [];
  const pattern = template.replace(/\{([^/}]+)\}/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${pattern}$`), paramNames, methodId };
}

/**
 * The explicit REST route table. Every entry is a path a gateway verb
 * descriptor advertises in its http binding; keep this in lockstep with those
 * bindings (the reconcile gate enforces it).
 */
export const GATEWAY_REST_ROUTES: readonly GatewayRestRoute[] = [
  // skills.*
  route('GET', '/api/skills', 'skills.list'),
  route('POST', '/api/skills', 'skills.create'),
  route('GET', '/api/skills/{name}', 'skills.get'),
  route('DELETE', '/api/skills/{name}', 'skills.delete'),
  route('POST', '/api/skills/{name}/update', 'skills.update'),
  // principals.*
  route('GET', '/api/principals', 'principals.list'),
  route('POST', '/api/principals', 'principals.create'),
  route('POST', '/api/principals/resolve', 'principals.resolve'),
  route('GET', '/api/principals/{principalId}', 'principals.get'),
  route('DELETE', '/api/principals/{principalId}', 'principals.delete'),
  route('POST', '/api/principals/{principalId}/update', 'principals.update'),
  // profile.* — the owner profile (docs/owner-profile.md §11.1). `person` is a
  // POST with the name in the body rather than a GET with it in the path: a
  // path segment lands in every access log and proxy trace it passes through,
  // and the whole point of the People section's containment is that a person's
  // name is not something to scatter around because a URL shape was convenient.
  route('GET', '/api/profile', 'profile.read'),
  route('GET', '/api/profile/status', 'profile.status'),
  route('POST', '/api/profile/person', 'profile.person'),
  route('GET', '/api/profile/fields/{fieldId}', 'profile.get'),
  route('GET', '/api/profile/fields/{fieldId}/provenance', 'profile.provenance'),
  route('POST', '/api/profile/set', 'profile.set'),
  route('POST', '/api/profile/append', 'profile.append'),
  route('POST', '/api/profile/forget', 'profile.forget'),
  route('POST', '/api/profile/undo', 'profile.undo'),

  // occasions.* — the owner's important dates and plans, and the loop that
  // raises them (docs/occasions.md §7). The two verbs that read a whole
  // collection are GET; everything that names one thing, answers a question or
  // writes a line takes a body and is POST.
  route('GET', '/api/occasions', 'occasions.list'),
  route('GET', '/api/occasions/pending', 'occasions.pending'),
  route('GET', '/api/occasions/state', 'occasions.state'),
  route('GET', '/api/occasions/plans', 'occasions.plans.list'),
  route('POST', '/api/occasions/propose', 'occasions.propose'),
  route('POST', '/api/occasions/confirm', 'occasions.confirm'),
  route('POST', '/api/occasions/remove', 'occasions.remove'),
  route('POST', '/api/occasions/answer', 'occasions.answer'),
  route('POST', '/api/occasions/interview', 'occasions.interview.get'),
  route('POST', '/api/occasions/interview/answer', 'occasions.interview.answer'),
  route('POST', '/api/occasions/interview/record', 'occasions.interview.record'),
  route('POST', '/api/occasions/gifts', 'occasions.gifts'),
  route('POST', '/api/occasions/sweep', 'occasions.sweep'),
  route('POST', '/api/occasions/conflict/resolve', 'occasions.conflict.resolve'),
  route('POST', '/api/occasions/plans/propose', 'occasions.plans.propose'),
  route('POST', '/api/occasions/plans/confirm', 'occasions.plans.confirm'),
  // checkin.*
  route('GET', '/api/checkin/config', 'checkin.config.get'),
  route('POST', '/api/checkin/config', 'checkin.config.set'),
  route('GET', '/api/checkin/receipts', 'checkin.receipts.list'),
  route('POST', '/api/checkin/run', 'checkin.run'),
  // ci.*
  route('POST', '/api/ci/status', 'ci.status'),
  route('GET', '/api/ci/watches', 'ci.watches.list'),
  route('POST', '/api/ci/watches', 'ci.watches.create'),
  route('DELETE', '/api/ci/watches/{watchId}', 'ci.watches.delete'),
  route('POST', '/api/ci/watches/{watchId}/run', 'ci.watches.run'),
  // channels.profiles.*
  route('GET', '/api/channels/profiles', 'channels.profiles.list'),
  route('POST', '/api/channels/profiles', 'channels.profiles.set'),
  route('GET', '/api/channels/profiles/{surfaceKind}', 'channels.profiles.get'),
  route('DELETE', '/api/channels/profiles/{surfaceKind}', 'channels.profiles.delete'),
  // workspaces.* (registered-workspace registry)
  route('GET', '/api/workspaces/registrations', 'workspaces.registrations.list'),
  route('POST', '/api/workspaces/registrations', 'workspaces.registrations.add'),
  route('DELETE', '/api/workspaces/registrations', 'workspaces.registrations.remove'),
  route('POST', '/api/workspaces/resolve', 'workspaces.resolve'),
  // sessions.permissionMode.* + sessions.contextUsage.get
  route('GET', '/api/sessions/{sessionId}/permission-mode', 'sessions.permissionMode.get'),
  route('POST', '/api/sessions/{sessionId}/permission-mode', 'sessions.permissionMode.set'),
  route('GET', '/api/sessions/{sessionId}/context-usage', 'sessions.contextUsage.get'),
  // Live-turn verbs: per-call cancel + queued mid-turn message management.
  route('POST', '/api/sessions/{sessionId}/tool-calls/{callId}/cancel', 'sessions.toolCalls.cancel'),
  route('GET', '/api/sessions/{sessionId}/queued-messages', 'sessions.queuedMessages.list'),
  route('POST', '/api/sessions/{sessionId}/queued-messages/{messageId}', 'sessions.queuedMessages.edit'),
  route('DELETE', '/api/sessions/{sessionId}/queued-messages/{messageId}', 'sessions.queuedMessages.delete'),
  // stepup.* — relay WebAuthn step-up ceremony (register a credential, mint a
  // challenge). Both handler-backed gateway verbs with an advertised REST path.
  route('POST', '/api/stepup/credentials', 'stepup.credentials.register'),
  route('POST', '/api/stepup/challenge', 'stepup.challenge.mint'),
  // memory.projections.* — the live read-only projection of standing memory
  // records (project/team scope) to their markdown form. Handler-backed gateway
  // verbs with an advertised REST path, so they need parity entries here (the
  // Pattern-B memory.records.* verbs are served by operator.ts's own table
  // instead and are intentionally NOT listed here).
  route('GET', '/api/memory/projections', 'memory.projections.list'),
  route('GET', '/api/memory/projections/{id}', 'memory.projections.get'),
  // runtime.metrics.get — the process-wide RuntimeMeter snapshot. This is the
  // sole route for GET /api/runtime/metrics: the daemon-sdk raw handler that
  // once served it was removed in favor of this gateway-verb parity entry, so
  // the URL now resolves to the same in-process handler (and the same
  // read:telemetry scope gate) as the methodId-invoke endpoint. Because
  // dispatchDaemonApiRoutes tries the gateway-REST table BEFORE the operator
  // dispatcher, this entry is what answers the URL.
  route('GET', '/api/runtime/metrics', 'runtime.metrics.get'),
  // fleet.graph.get — the workstream task-graph view.
  route('GET', '/api/fleet/workstreams/{workstreamId}/graph', 'fleet.graph.get'),
  // power.* — sleep ownership: the chip state + the owner keep-awake toggle.
  route('GET', '/api/power/status', 'power.status.get'),
  route('POST', '/api/power/keep-awake', 'power.keepAwake.set'),
  // devices.* — paired-phone capability nodes, the durable "always allow"
  // grants surface, and the housekeeping sweep with its disclosure.
  route('GET', '/api/devices/nodes', 'devices.nodes.list'),
  route('GET', '/api/devices/grants', 'devices.grants.list'),
  route('POST', '/api/devices/grants/revoke', 'devices.grants.revoke'),
  route('POST', '/api/devices/housekeeping', 'devices.housekeeping.run'),
  // ops.memory.get — the MemoryGovernor snapshot (tier, budget, RSS/heap,
  // per-cache footprints, paused jobs, tripwire state).
  route('GET', '/api/ops/memory', 'ops.memory.get'),
  // voice.local.* — managed local-voice runtime status + one-act install.
  route('GET', '/api/voice/local/status', 'voice.local.status'),
  route('POST', '/api/voice/local/install', 'voice.local.install'),
  // voice.wake.* — the pinned wake-word artifacts: content-verified state, the
  // explicit ~3.7MB provision, and a bounded chunked read of one artifact's
  // bytes. The last exists because a browser tab cannot fetch the pinned asset
  // itself (the release asset answers with no CORS header), so the tab reads it
  // from here, same-origin, and verifies what it reassembled against the
  // pinned checksum each chunk restates.
  route('GET', '/api/voice/wake/status', 'voice.wake.status'),
  route('POST', '/api/voice/wake/provision', 'voice.wake.provision'),
  route('GET', '/api/voice/wake/model', 'voice.wake.model.get'),
  // calendar.* — event read/write and iCalendar import/export over the
  // platform Google connector. These paths were advertised for a long time
  // with nothing behind them, because the connector lived inside one product
  // and the daemon had no implementation to call; the descriptors carried
  // `invokable: false` to say so honestly. The connector is platform
  // capability now (platform/google), so the paths are real.
  route('GET', '/api/calendar/events', 'calendar.events.list'),
  route('GET', '/api/calendar/events/{eventId}', 'calendar.events.get'),
  route('POST', '/api/calendar/events', 'calendar.events.create'),
  route('GET', '/api/calendar/ics/export', 'calendar.ics.export'),
  route('POST', '/api/calendar/ics/import', 'calendar.ics.import'),
  // email.* — inbox read and outbound send over the platform IMAP/SMTP
  // service. Same story as calendar above, with a sharper consequence: while
  // there was no daemon-reachable implementation, nothing the daemon did on
  // its own — a schedule, a trigger, a channel reply — could send mail.
  route('GET', '/api/email/inbox', 'email.inbox.list'),
  route('GET', '/api/email/inbox/{uid}', 'email.inbox.read'),
  route('POST', '/api/email/drafts', 'email.draft.create'),
  route('POST', '/api/email/send', 'email.send'),

  // payments.* — the daemon holds the card and charges it, so every surface
  // reads and writes this over the wire. Card material goes IN through
  // cards.create and has no read route by design; see routes/payments.ts.
  route('GET', '/api/payments/budget', 'payments.budget.status'),
  route('GET', '/api/payments/cards', 'payments.cards.list'),
  route('POST', '/api/payments/cards', 'payments.cards.create'),
  route('DELETE', '/api/payments/cards/{id}', 'payments.cards.delete'),
  // The daemon types the stored card into an open checkout page. Takes a card
  // id and field targets, answers with field names and a boolean — no request
  // or response on this route carries card material in either direction.
  route('POST', '/api/payments/checkout/begin', 'payments.checkout.begin'),
  route('POST', '/api/payments/checkout/fill-card', 'payments.checkout.fillCard'),
  route('GET', '/api/payments/purchases', 'payments.purchases.list'),
  // browser.* — real browser control over the platform engine. The engine was
  // hoisted into the SDK and the daemon could link it, but no verb and no path
  // existed, so a daemon-only caller had nothing to invoke: with no surface
  // process attached, a schedule, a trigger or a channel reply could not open
  // a page at all. The whole surface is routed rather than a convenient
  // subset, because a daemon that can navigate but cannot select an option is
  // still a daemon an operator has to open a surface for.
  route('GET', '/api/browser/status', 'browser.status'),
  route('POST', '/api/browser/provision', 'browser.provision'),
  route('GET', '/api/browser/sessions', 'browser.sessions.list'),
  route('POST', '/api/browser/sessions/launch', 'browser.sessions.launch'),
  route('POST', '/api/browser/sessions/attach', 'browser.sessions.attach'),
  route('POST', '/api/browser/sessions/release', 'browser.sessions.release'),
  route('POST', '/api/browser/sessions/close', 'browser.sessions.close'),
  route('POST', '/api/browser/navigate', 'browser.navigate'),
  route('POST', '/api/browser/snapshot', 'browser.snapshot'),
  route('POST', '/api/browser/click', 'browser.click'),
  route('POST', '/api/browser/type', 'browser.type'),
  route('POST', '/api/browser/select', 'browser.select'),
  route('POST', '/api/browser/press', 'browser.press'),
  route('POST', '/api/browser/scroll', 'browser.scroll'),
  route('POST', '/api/browser/wait-for', 'browser.waitFor'),
  route('POST', '/api/browser/read-text', 'browser.readText'),
  route('POST', '/api/browser/extract', 'browser.extract'),
  route('POST', '/api/browser/screenshot', 'browser.screenshot'),
  route('GET', '/api/browser/tabs', 'browser.tabs.list'),
  route('POST', '/api/browser/tabs', 'browser.tabs.create'),
  route('POST', '/api/browser/tabs/switch', 'browser.tabs.switch'),
  route('POST', '/api/browser/tabs/close', 'browser.tabs.close'),
  route('POST', '/api/browser/history/back', 'browser.history.back'),
  route('POST', '/api/browser/history/forward', 'browser.history.forward'),
];

/**
 * Dispatch a request against the gateway REST route table.
 *
 * Returns the handler's `Response` when a path+method entry matches, or `null`
 * when nothing matches (so the caller falls through to the rest of the route
 * chain / a 404). When the daemon has not wired `invokeGatewayRestVerb` (e.g. a
 * minimal embed), a matching path returns `null` rather than throwing — it
 * degrades to the same 404 the caller saw before these routes existed.
 */
/**
 * Header carrying how many synthesized dispatches a request is already deep.
 *
 * Lives here rather than beside the guard that reads it because this module
 * owns the table that made a cycle possible: these rows map an advertised path
 * back to its own methodId, so a verb reaching the synthesizing arm of
 * `invokeGatewayMethodCall` lands right back here. Absent on a request from a
 * real client; `1` on the first synthesis.
 */
export const SYNTHESIZED_DISPATCH_HEADER = 'x-goodvibes-synthesized-dispatch';

/** Read the synthesized-dispatch depth off a request. 0 when unmarked. */
export function readSynthesizedDispatchDepth(req: Request): number {
  const raw = req.headers.get(SYNTHESIZED_DISPATCH_HEADER);
  if (raw === null) return 0;
  const depth = Number.parseInt(raw, 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

export async function dispatchGatewayRestRoutes(
  req: Request,
  handlers: Partial<DaemonGatewayRestRouteHandlers>,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const method = req.method;
  for (const entry of GATEWAY_REST_ROUTES) {
    if (entry.method !== method) continue;
    const match = entry.regex.exec(pathname);
    if (!match) continue;
    if (typeof handlers.invokeGatewayRestVerb !== 'function') return null;
    const params: Record<string, string> = {};
    entry.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]!);
    });
    return handlers.invokeGatewayRestVerb({ methodId: entry.methodId, req, params });
  }
  return null;
}
