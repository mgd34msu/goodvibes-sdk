import type { OperatorMethodInput, OperatorMethodOutput } from './foundation-client-types.js';
import type { OperatorMethodId } from './operator-method-ids.js';

/**
 * GENERATED — do not edit. Regenerate with `bun run refresh:contracts`.
 *
 * The mechanical transport layer for the webui facade (src/lib/goodvibes.ts),
 * emitted from the operator contract by scripts/generate-webui-facade.ts. The
 * webui keeps its ergonomic wrappers (route interpolation, per-family typed
 * call sites) hand-written on top of these generated primitives.
 *
 * Contract product version: 1.8.0
 * Methods: 403 total, 353 REST-routed, 50 ws-only invoke.
 */

export type WebuiHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface WebuiRouteDefinition {
  readonly method: WebuiHttpMethod;
  /** May contain {param} placeholders folded in from the method input. */
  readonly path: string;
}

/** How a method is reached over the wire. */
export type WebuiMethodDisposition = 'rest' | 'ws-invoke';

/** One generated bridge sample: schema-valid input and output for a method. */
export interface WebuiMethodSample {
  readonly input: unknown;
  readonly output: unknown;
}

/**
 * Every operator method that advertises a plain-REST http binding, keyed by
 * method id. The webui derives its EXTRA_METHOD_ROUTES from this by removing
 * the ids its pinned browser SDK route maps already cover.
 */
export const WEBUI_METHOD_ROUTES: Readonly<Record<string, WebuiRouteDefinition>> = {
  "accounts.snapshot": {
    "method": "GET",
    "path": "/api/accounts"
  },
  "approvals.approve": {
    "method": "POST",
    "path": "/api/approvals/{approvalId}/approve"
  },
  "approvals.cancel": {
    "method": "POST",
    "path": "/api/approvals/{approvalId}/cancel"
  },
  "approvals.claim": {
    "method": "POST",
    "path": "/api/approvals/{approvalId}/claim"
  },
  "approvals.deny": {
    "method": "POST",
    "path": "/api/approvals/{approvalId}/deny"
  },
  "approvals.list": {
    "method": "GET",
    "path": "/api/approvals"
  },
  "artifacts.content.get": {
    "method": "GET",
    "path": "/api/artifacts/{artifactId}/content"
  },
  "artifacts.create": {
    "method": "POST",
    "path": "/api/artifacts"
  },
  "artifacts.get": {
    "method": "GET",
    "path": "/api/artifacts/{artifactId}"
  },
  "artifacts.list": {
    "method": "GET",
    "path": "/api/artifacts"
  },
  "local_auth.bootstrap.delete": {
    "method": "DELETE",
    "path": "/api/local-auth/bootstrap-file"
  },
  "local_auth.sessions.delete": {
    "method": "DELETE",
    "path": "/api/local-auth/sessions/{sessionId}"
  },
  "local_auth.status": {
    "method": "GET",
    "path": "/api/local-auth"
  },
  "local_auth.users.create": {
    "method": "POST",
    "path": "/api/local-auth/users"
  },
  "local_auth.users.delete": {
    "method": "DELETE",
    "path": "/api/local-auth/users/{username}"
  },
  "local_auth.users.password.rotate": {
    "method": "POST",
    "path": "/api/local-auth/users/{username}/password"
  },
  "automation.heartbeat.list": {
    "method": "GET",
    "path": "/api/automation/heartbeat"
  },
  "automation.heartbeat.run": {
    "method": "POST",
    "path": "/api/automation/heartbeat"
  },
  "automation.integration.snapshot": {
    "method": "GET",
    "path": "/api/automation"
  },
  "automation.jobs.create": {
    "method": "POST",
    "path": "/api/automation/jobs"
  },
  "automation.jobs.delete": {
    "method": "DELETE",
    "path": "/api/automation/jobs/{jobId}"
  },
  "automation.jobs.disable": {
    "method": "POST",
    "path": "/api/automation/jobs/{jobId}/disable"
  },
  "automation.jobs.enable": {
    "method": "POST",
    "path": "/api/automation/jobs/{jobId}/enable"
  },
  "automation.jobs.list": {
    "method": "GET",
    "path": "/api/automation/jobs"
  },
  "automation.jobs.run": {
    "method": "POST",
    "path": "/api/automation/jobs/{jobId}/run"
  },
  "automation.jobs.update": {
    "method": "PATCH",
    "path": "/api/automation/jobs/{jobId}"
  },
  "automation.runs.cancel": {
    "method": "POST",
    "path": "/api/automation/runs/{runId}/cancel"
  },
  "automation.runs.get": {
    "method": "GET",
    "path": "/api/automation/runs/{runId}"
  },
  "automation.runs.list": {
    "method": "GET",
    "path": "/api/automation/runs"
  },
  "automation.runs.retry": {
    "method": "POST",
    "path": "/api/automation/runs/{runId}/retry"
  },
  "automation.schedules.create": {
    "method": "POST",
    "path": "/api/automation/schedules"
  },
  "automation.schedules.delete": {
    "method": "DELETE",
    "path": "/api/automation/schedules/{scheduleId}"
  },
  "automation.schedules.disable": {
    "method": "POST",
    "path": "/api/automation/schedules/{scheduleId}/disable"
  },
  "automation.schedules.enable": {
    "method": "POST",
    "path": "/api/automation/schedules/{scheduleId}/enable"
  },
  "automation.schedules.list": {
    "method": "GET",
    "path": "/api/automation/schedules"
  },
  "automation.schedules.run": {
    "method": "POST",
    "path": "/api/automation/schedules/{scheduleId}/run"
  },
  "calendar.events.create": {
    "method": "POST",
    "path": "/api/calendar/events"
  },
  "calendar.events.get": {
    "method": "GET",
    "path": "/api/calendar/events/{eventId}"
  },
  "calendar.events.list": {
    "method": "GET",
    "path": "/api/calendar/events"
  },
  "calendar.ics.export": {
    "method": "GET",
    "path": "/api/calendar/ics/export"
  },
  "calendar.ics.import": {
    "method": "POST",
    "path": "/api/calendar/ics/import"
  },
  "channels.accounts.action.default": {
    "method": "POST",
    "path": "/api/channels/accounts/{surface}/actions/{action}"
  },
  "channels.accounts.action.named": {
    "method": "POST",
    "path": "/api/channels/accounts/{surface}/{accountId}/actions/{action}"
  },
  "channels.accounts.get": {
    "method": "GET",
    "path": "/api/channels/accounts/{surface}/{accountId}"
  },
  "channels.accounts.list": {
    "method": "GET",
    "path": "/api/channels/accounts"
  },
  "channels.accounts.surface.list": {
    "method": "GET",
    "path": "/api/channels/accounts/{surface}"
  },
  "channels.actions.invoke": {
    "method": "POST",
    "path": "/api/channels/actions/{surface}/{actionId}"
  },
  "channels.actions.list": {
    "method": "GET",
    "path": "/api/channels/actions"
  },
  "channels.actions.surface.list": {
    "method": "GET",
    "path": "/api/channels/actions/{surface}"
  },
  "channels.agent_tools.list": {
    "method": "GET",
    "path": "/api/channels/agent-tools"
  },
  "channels.agent_tools.surface.list": {
    "method": "GET",
    "path": "/api/channels/agent-tools/{surface}"
  },
  "channels.allowlist.edit": {
    "method": "POST",
    "path": "/api/channels/allowlist/{surface}/edit"
  },
  "channels.allowlist.resolve": {
    "method": "POST",
    "path": "/api/channels/allowlist/{surface}/resolve"
  },
  "channels.authorize": {
    "method": "POST",
    "path": "/api/channels/authorize/{surface}"
  },
  "channels.capabilities.list": {
    "method": "GET",
    "path": "/api/channels/capabilities"
  },
  "channels.capabilities.surface.list": {
    "method": "GET",
    "path": "/api/channels/capabilities/{surface}"
  },
  "channels.directory.query": {
    "method": "GET",
    "path": "/api/channels/directory/{surface}"
  },
  "channels.doctor.get": {
    "method": "GET",
    "path": "/api/channels/doctor/{surface}"
  },
  "channels.drafts.delete": {
    "method": "DELETE",
    "path": "/api/channels/drafts/{draftId}"
  },
  "channels.drafts.get": {
    "method": "GET",
    "path": "/api/channels/drafts/{draftId}"
  },
  "channels.drafts.list": {
    "method": "GET",
    "path": "/api/channels/drafts"
  },
  "channels.drafts.save": {
    "method": "POST",
    "path": "/api/channels/drafts"
  },
  "channels.inbox.list": {
    "method": "GET",
    "path": "/api/channels/inbox"
  },
  "channels.lifecycle.get": {
    "method": "GET",
    "path": "/api/channels/lifecycle/{surface}"
  },
  "channels.policies.audit": {
    "method": "GET",
    "path": "/api/channels/policies/audit"
  },
  "channels.policies.list": {
    "method": "GET",
    "path": "/api/channels/policies"
  },
  "channels.policies.update": {
    "method": "POST",
    "path": "/api/channels/policies/{surface}"
  },
  "channels.profiles.delete": {
    "method": "DELETE",
    "path": "/api/channels/profiles/{surfaceKind}"
  },
  "channels.profiles.get": {
    "method": "GET",
    "path": "/api/channels/profiles/{surfaceKind}"
  },
  "channels.profiles.list": {
    "method": "GET",
    "path": "/api/channels/profiles"
  },
  "channels.profiles.set": {
    "method": "POST",
    "path": "/api/channels/profiles"
  },
  "channels.repairs.list": {
    "method": "GET",
    "path": "/api/channels/repair-actions/{surface}"
  },
  "channels.routing.assign": {
    "method": "POST",
    "path": "/api/channels/routing"
  },
  "channels.routing.delete": {
    "method": "DELETE",
    "path": "/api/channels/routing/{assignmentId}"
  },
  "channels.routing.list": {
    "method": "GET",
    "path": "/api/channels/routing"
  },
  "channels.setup.get": {
    "method": "GET",
    "path": "/api/channels/setup/{surface}"
  },
  "channels.status": {
    "method": "GET",
    "path": "/api/channels/status"
  },
  "channels.targets.resolve": {
    "method": "POST",
    "path": "/api/channels/targets/{surface}/resolve"
  },
  "channels.tools.invoke": {
    "method": "POST",
    "path": "/api/channels/tools/{surface}/{toolId}"
  },
  "channels.tools.list": {
    "method": "GET",
    "path": "/api/channels/tools"
  },
  "channels.tools.surface.list": {
    "method": "GET",
    "path": "/api/channels/tools/{surface}"
  },
  "checkin.config.get": {
    "method": "GET",
    "path": "/api/checkin/config"
  },
  "checkin.config.set": {
    "method": "POST",
    "path": "/api/checkin/config"
  },
  "checkin.receipts.list": {
    "method": "GET",
    "path": "/api/checkin/receipts"
  },
  "checkin.run": {
    "method": "POST",
    "path": "/api/checkin/run"
  },
  "ci.status": {
    "method": "POST",
    "path": "/api/ci/status"
  },
  "ci.watches.create": {
    "method": "POST",
    "path": "/api/ci/watches"
  },
  "ci.watches.delete": {
    "method": "DELETE",
    "path": "/api/ci/watches/{watchId}"
  },
  "ci.watches.list": {
    "method": "GET",
    "path": "/api/ci/watches"
  },
  "ci.watches.run": {
    "method": "POST",
    "path": "/api/ci/watches/{watchId}/run"
  },
  "companion.chat.events.stream": {
    "method": "GET",
    "path": "/api/companion/chat/sessions/{sessionId}/events"
  },
  "companion.chat.messages.create": {
    "method": "POST",
    "path": "/api/companion/chat/sessions/{sessionId}/messages"
  },
  "companion.chat.messages.edit": {
    "method": "POST",
    "path": "/api/companion/chat/sessions/{sessionId}/messages/edit"
  },
  "companion.chat.messages.list": {
    "method": "GET",
    "path": "/api/companion/chat/sessions/{sessionId}/messages"
  },
  "companion.chat.messages.retry": {
    "method": "POST",
    "path": "/api/companion/chat/sessions/{sessionId}/messages/retry"
  },
  "companion.chat.messages.steer": {
    "method": "POST",
    "path": "/api/companion/chat/sessions/{sessionId}/messages/steer"
  },
  "companion.chat.sessions.close": {
    "method": "POST",
    "path": "/api/companion/chat/sessions/{sessionId}/close"
  },
  "companion.chat.sessions.create": {
    "method": "POST",
    "path": "/api/companion/chat/sessions"
  },
  "companion.chat.sessions.delete": {
    "method": "DELETE",
    "path": "/api/companion/chat/sessions/{sessionId}"
  },
  "companion.chat.sessions.get": {
    "method": "GET",
    "path": "/api/companion/chat/sessions/{sessionId}"
  },
  "companion.chat.sessions.list": {
    "method": "GET",
    "path": "/api/companion/chat/sessions"
  },
  "companion.chat.sessions.update": {
    "method": "PATCH",
    "path": "/api/companion/chat/sessions/{sessionId}"
  },
  "companion.chat.turns.cancel": {
    "method": "POST",
    "path": "/api/companion/chat/sessions/{sessionId}/turns/cancel"
  },
  "config.get": {
    "method": "GET",
    "path": "/config"
  },
  "config.set": {
    "method": "POST",
    "path": "/config"
  },
  "credentials.get": {
    "method": "GET",
    "path": "/config/credentials"
  },
  "continuity.snapshot": {
    "method": "GET",
    "path": "/api/continuity"
  },
  "control.auth.current": {
    "method": "GET",
    "path": "/api/control-plane/auth"
  },
  "control.auth.login": {
    "method": "POST",
    "path": "/login"
  },
  "control.clients.list": {
    "method": "GET",
    "path": "/api/control-plane/clients"
  },
  "control.contract": {
    "method": "GET",
    "path": "/api/control-plane/contract"
  },
  "control.events.catalog": {
    "method": "GET",
    "path": "/api/control-plane/events/catalog"
  },
  "control.events.stream": {
    "method": "GET",
    "path": "/api/control-plane/events"
  },
  "control.messages.list": {
    "method": "GET",
    "path": "/api/control-plane/messages"
  },
  "control.methods.get": {
    "method": "GET",
    "path": "/api/control-plane/methods/{methodId}"
  },
  "control.methods.list": {
    "method": "GET",
    "path": "/api/control-plane/methods"
  },
  "control.snapshot": {
    "method": "GET",
    "path": "/api/control-plane"
  },
  "control.status": {
    "method": "GET",
    "path": "/status"
  },
  "control.web": {
    "method": "GET",
    "path": "/api/control-plane/web"
  },
  "deliveries.get": {
    "method": "GET",
    "path": "/api/deliveries/{deliveryId}"
  },
  "deliveries.list": {
    "method": "GET",
    "path": "/api/deliveries"
  },
  "email.draft.create": {
    "method": "POST",
    "path": "/api/email/drafts"
  },
  "email.inbox.list": {
    "method": "GET",
    "path": "/api/email/inbox"
  },
  "email.inbox.read": {
    "method": "GET",
    "path": "/api/email/inbox/{uid}"
  },
  "email.send": {
    "method": "POST",
    "path": "/api/email/send"
  },
  "health.snapshot": {
    "method": "GET",
    "path": "/api/health"
  },
  "intelligence.snapshot": {
    "method": "GET",
    "path": "/api/intelligence"
  },
  "homeassistant.homeGraph.askHomeGraph": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/ask"
  },
  "homeassistant.homeGraph.browse": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/browse"
  },
  "homeassistant.homeGraph.export": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/export"
  },
  "homeassistant.homeGraph.generateHomeGraphPacket": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/packet"
  },
  "homeassistant.homeGraph.generateRoomPage": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/room-page"
  },
  "homeassistant.homeGraph.import": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/import"
  },
  "homeassistant.homeGraph.ingestHomeGraphArtifact": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/ingest/artifact"
  },
  "homeassistant.homeGraph.ingestHomeGraphNote": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/ingest/note"
  },
  "homeassistant.homeGraph.ingestHomeGraphUrl": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/ingest/url"
  },
  "homeassistant.homeGraph.linkHomeGraphKnowledge": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/link"
  },
  "homeassistant.homeGraph.listHomeGraphIssues": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/issues"
  },
  "homeassistant.homeGraph.map": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/map"
  },
  "homeassistant.homeGraph.pages.list": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/pages"
  },
  "homeassistant.homeGraph.refinement.run": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/refinement/run"
  },
  "homeassistant.homeGraph.refinement.task.cancel": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/refinement/tasks/{id}/cancel"
  },
  "homeassistant.homeGraph.refinement.task.get": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/refinement/tasks/{id}"
  },
  "homeassistant.homeGraph.refinement.tasks.list": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/refinement/tasks"
  },
  "homeassistant.homeGraph.refreshDevicePassport": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/device-passport"
  },
  "homeassistant.homeGraph.reindex": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/reindex"
  },
  "homeassistant.homeGraph.reset": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/reset"
  },
  "homeassistant.homeGraph.reviewHomeGraphFact": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/facts/review"
  },
  "homeassistant.homeGraph.sources.list": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/sources"
  },
  "homeassistant.homeGraph.status": {
    "method": "GET",
    "path": "/api/homeassistant/home-graph/status"
  },
  "homeassistant.homeGraph.syncHomeGraph": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/sync"
  },
  "homeassistant.homeGraph.unlinkHomeGraphKnowledge": {
    "method": "POST",
    "path": "/api/homeassistant/home-graph/unlink"
  },
  "knowledge.ask": {
    "method": "POST",
    "path": "/api/knowledge/ask"
  },
  "knowledge.candidate.decide": {
    "method": "POST",
    "path": "/api/knowledge/candidates/{id}/decide"
  },
  "knowledge.candidate.get": {
    "method": "GET",
    "path": "/api/knowledge/candidates/{id}"
  },
  "knowledge.candidates.list": {
    "method": "GET",
    "path": "/api/knowledge/candidates"
  },
  "knowledge.connector.doctor": {
    "method": "GET",
    "path": "/api/knowledge/connectors/{id}/doctor"
  },
  "knowledge.connector.get": {
    "method": "GET",
    "path": "/api/knowledge/connectors/{id}"
  },
  "knowledge.connectors.list": {
    "method": "GET",
    "path": "/api/knowledge/connectors"
  },
  "knowledge.extraction.get": {
    "method": "GET",
    "path": "/api/knowledge/extractions/{id}"
  },
  "knowledge.extractions.list": {
    "method": "GET",
    "path": "/api/knowledge/extractions"
  },
  "knowledge.graphql.execute": {
    "method": "POST",
    "path": "/api/knowledge/graphql"
  },
  "knowledge.graphql.schema": {
    "method": "GET",
    "path": "/api/knowledge/graphql/schema"
  },
  "knowledge.ingest.artifact": {
    "method": "POST",
    "path": "/api/knowledge/ingest/artifact"
  },
  "knowledge.ingest.bookmarks": {
    "method": "POST",
    "path": "/api/knowledge/ingest/bookmarks"
  },
  "knowledge.ingest.browserHistory": {
    "method": "POST",
    "path": "/api/knowledge/ingest/browser-history"
  },
  "knowledge.ingest.connector": {
    "method": "POST",
    "path": "/api/knowledge/ingest/connector"
  },
  "knowledge.ingest.url": {
    "method": "POST",
    "path": "/api/knowledge/ingest/url"
  },
  "knowledge.ingest.urls": {
    "method": "POST",
    "path": "/api/knowledge/ingest/urls"
  },
  "knowledge.issue.review": {
    "method": "POST",
    "path": "/api/knowledge/issues/{id}/review"
  },
  "knowledge.issues.list": {
    "method": "GET",
    "path": "/api/knowledge/issues"
  },
  "knowledge.item.get": {
    "method": "GET",
    "path": "/api/knowledge/items/{id}"
  },
  "knowledge.job-runs.list": {
    "method": "GET",
    "path": "/api/knowledge/job-runs"
  },
  "knowledge.job.get": {
    "method": "GET",
    "path": "/api/knowledge/jobs/{jobId}"
  },
  "knowledge.job.run": {
    "method": "POST",
    "path": "/api/knowledge/jobs/{jobId}/run"
  },
  "knowledge.jobs.list": {
    "method": "GET",
    "path": "/api/knowledge/jobs"
  },
  "knowledge.lint": {
    "method": "POST",
    "path": "/api/knowledge/lint"
  },
  "knowledge.map": {
    "method": "GET",
    "path": "/api/knowledge/map"
  },
  "knowledge.nodes.list": {
    "method": "GET",
    "path": "/api/knowledge/nodes"
  },
  "knowledge.packet": {
    "method": "POST",
    "path": "/api/knowledge/packet"
  },
  "knowledge.projection.materialize": {
    "method": "POST",
    "path": "/api/knowledge/projections/materialize"
  },
  "knowledge.projection.render": {
    "method": "POST",
    "path": "/api/knowledge/projections/render"
  },
  "knowledge.projections.list": {
    "method": "GET",
    "path": "/api/knowledge/projections"
  },
  "knowledge.refinement.run": {
    "method": "POST",
    "path": "/api/knowledge/refinement/run"
  },
  "knowledge.refinement.task.cancel": {
    "method": "POST",
    "path": "/api/knowledge/refinement/tasks/{id}/cancel"
  },
  "knowledge.refinement.task.get": {
    "method": "GET",
    "path": "/api/knowledge/refinement/tasks/{id}"
  },
  "knowledge.refinement.tasks.list": {
    "method": "GET",
    "path": "/api/knowledge/refinement/tasks"
  },
  "knowledge.reindex": {
    "method": "POST",
    "path": "/api/knowledge/reindex"
  },
  "knowledge.report.get": {
    "method": "GET",
    "path": "/api/knowledge/reports/{id}"
  },
  "knowledge.reports.list": {
    "method": "GET",
    "path": "/api/knowledge/reports"
  },
  "knowledge.schedule.delete": {
    "method": "DELETE",
    "path": "/api/knowledge/schedules/{id}"
  },
  "knowledge.schedule.enable": {
    "method": "POST",
    "path": "/api/knowledge/schedules/{id}/enabled"
  },
  "knowledge.schedule.get": {
    "method": "GET",
    "path": "/api/knowledge/schedules/{id}"
  },
  "knowledge.schedule.save": {
    "method": "POST",
    "path": "/api/knowledge/schedules"
  },
  "knowledge.schedules.list": {
    "method": "GET",
    "path": "/api/knowledge/schedules"
  },
  "knowledge.search": {
    "method": "POST",
    "path": "/api/knowledge/search"
  },
  "knowledge.source.extraction.get": {
    "method": "GET",
    "path": "/api/knowledge/sources/{id}/extraction"
  },
  "knowledge.sources.list": {
    "method": "GET",
    "path": "/api/knowledge/sources"
  },
  "knowledge.status": {
    "method": "GET",
    "path": "/api/knowledge/status"
  },
  "knowledge.usage.list": {
    "method": "GET",
    "path": "/api/knowledge/usage"
  },
  "projectPlanning.decisions.list": {
    "method": "GET",
    "path": "/api/projects/planning/decisions"
  },
  "projectPlanning.decisions.record": {
    "method": "POST",
    "path": "/api/projects/planning/decisions"
  },
  "projectPlanning.evaluate": {
    "method": "POST",
    "path": "/api/projects/planning/evaluate"
  },
  "projectPlanning.language.get": {
    "method": "GET",
    "path": "/api/projects/planning/language"
  },
  "projectPlanning.language.upsert": {
    "method": "POST",
    "path": "/api/projects/planning/language"
  },
  "projectPlanning.state.get": {
    "method": "GET",
    "path": "/api/projects/planning/state"
  },
  "projectPlanning.state.upsert": {
    "method": "POST",
    "path": "/api/projects/planning/state"
  },
  "projectPlanning.status": {
    "method": "GET",
    "path": "/api/projects/planning/status"
  },
  "projectPlanning.workPlan.clearCompleted": {
    "method": "POST",
    "path": "/api/projects/planning/work-plan/clear-completed"
  },
  "projectPlanning.workPlan.snapshot": {
    "method": "GET",
    "path": "/api/projects/planning/work-plan"
  },
  "projectPlanning.workPlan.task.create": {
    "method": "POST",
    "path": "/api/projects/planning/work-plan/tasks"
  },
  "projectPlanning.workPlan.task.delete": {
    "method": "DELETE",
    "path": "/api/projects/planning/work-plan/tasks/{taskId}"
  },
  "projectPlanning.workPlan.task.get": {
    "method": "GET",
    "path": "/api/projects/planning/work-plan/tasks/{taskId}"
  },
  "projectPlanning.workPlan.task.status": {
    "method": "POST",
    "path": "/api/projects/planning/work-plan/tasks/{taskId}/status"
  },
  "projectPlanning.workPlan.task.update": {
    "method": "PATCH",
    "path": "/api/projects/planning/work-plan/tasks/{taskId}"
  },
  "projectPlanning.workPlan.tasks.list": {
    "method": "GET",
    "path": "/api/projects/planning/work-plan/tasks"
  },
  "projectPlanning.workPlan.tasks.reorder": {
    "method": "POST",
    "path": "/api/projects/planning/work-plan/tasks/reorder"
  },
  "mcp.config.get": {
    "method": "GET",
    "path": "/api/mcp/config"
  },
  "mcp.config.reload": {
    "method": "POST",
    "path": "/api/mcp/reload"
  },
  "mcp.servers.list": {
    "method": "GET",
    "path": "/api/mcp/servers"
  },
  "mcp.servers.remove": {
    "method": "DELETE",
    "path": "/api/mcp/config/servers/{serverName}"
  },
  "mcp.servers.upsert": {
    "method": "POST",
    "path": "/api/mcp/config/servers"
  },
  "mcp.tools.list": {
    "method": "GET",
    "path": "/api/mcp/tools"
  },
  "media.analyze": {
    "method": "POST",
    "path": "/api/media/analyze"
  },
  "media.generate": {
    "method": "POST",
    "path": "/api/media/generate"
  },
  "media.providers.list": {
    "method": "GET",
    "path": "/api/media/providers"
  },
  "media.transform": {
    "method": "POST",
    "path": "/api/media/transform"
  },
  "multimodal.analyze": {
    "method": "POST",
    "path": "/api/multimodal/analyze"
  },
  "multimodal.packet": {
    "method": "POST",
    "path": "/api/multimodal/packet"
  },
  "multimodal.providers.list": {
    "method": "GET",
    "path": "/api/multimodal/providers"
  },
  "multimodal.status": {
    "method": "GET",
    "path": "/api/multimodal"
  },
  "multimodal.writeback": {
    "method": "POST",
    "path": "/api/multimodal/writeback"
  },
  "memory.doctor": {
    "method": "GET",
    "path": "/api/memory/doctor"
  },
  "memory.embeddings.default.set": {
    "method": "POST",
    "path": "/api/memory/embeddings/default"
  },
  "memory.projections.get": {
    "method": "GET",
    "path": "/api/memory/projections/{id}"
  },
  "memory.projections.list": {
    "method": "GET",
    "path": "/api/memory/projections"
  },
  "memory.records.add": {
    "method": "POST",
    "path": "/api/memory/records"
  },
  "memory.records.delete": {
    "method": "DELETE",
    "path": "/api/memory/records/{id}"
  },
  "memory.records.export": {
    "method": "POST",
    "path": "/api/memory/records/export"
  },
  "memory.records.get": {
    "method": "GET",
    "path": "/api/memory/records/{id}"
  },
  "memory.records.import": {
    "method": "POST",
    "path": "/api/memory/records/import"
  },
  "memory.records.links.add": {
    "method": "POST",
    "path": "/api/memory/records/{id}/links"
  },
  "memory.records.links.list": {
    "method": "GET",
    "path": "/api/memory/records/{id}/links"
  },
  "memory.records.list": {
    "method": "POST",
    "path": "/api/memory/records/list"
  },
  "memory.records.search": {
    "method": "POST",
    "path": "/api/memory/records/search"
  },
  "memory.records.search-semantic": {
    "method": "POST",
    "path": "/api/memory/records/search-semantic"
  },
  "memory.records.update": {
    "method": "POST",
    "path": "/api/memory/records/{id}/update"
  },
  "memory.records.update-review": {
    "method": "POST",
    "path": "/api/memory/records/{id}/review"
  },
  "memory.review-queue": {
    "method": "GET",
    "path": "/api/memory/review-queue"
  },
  "memory.vector.rebuild": {
    "method": "POST",
    "path": "/api/memory/vector/rebuild"
  },
  "memory.vector.stats": {
    "method": "GET",
    "path": "/api/memory/vector"
  },
  "panels.list": {
    "method": "GET",
    "path": "/api/panels"
  },
  "panels.open": {
    "method": "POST",
    "path": "/api/panels/open"
  },
  "principals.create": {
    "method": "POST",
    "path": "/api/principals"
  },
  "principals.delete": {
    "method": "DELETE",
    "path": "/api/principals/{principalId}"
  },
  "principals.get": {
    "method": "GET",
    "path": "/api/principals/{principalId}"
  },
  "principals.list": {
    "method": "GET",
    "path": "/api/principals"
  },
  "principals.resolve": {
    "method": "POST",
    "path": "/api/principals/resolve"
  },
  "principals.update": {
    "method": "POST",
    "path": "/api/principals/{principalId}/update"
  },
  "providers.get": {
    "method": "GET",
    "path": "/api/providers/{providerId}"
  },
  "providers.list": {
    "method": "GET",
    "path": "/api/providers"
  },
  "providers.usage.get": {
    "method": "GET",
    "path": "/api/providers/{providerId}/usage"
  },
  "stepup.challenge.mint": {
    "method": "POST",
    "path": "/api/stepup/challenge"
  },
  "stepup.credentials.register": {
    "method": "POST",
    "path": "/api/stepup/credentials"
  },
  "remote.node_host.contract": {
    "method": "GET",
    "path": "/api/remote/node-host/contract"
  },
  "remote.pair.requests.approve": {
    "method": "POST",
    "path": "/api/remote/pair/requests/{requestId}/approve"
  },
  "remote.pair.requests.list": {
    "method": "GET",
    "path": "/api/remote/pair/requests"
  },
  "remote.pair.requests.reject": {
    "method": "POST",
    "path": "/api/remote/pair/requests/{requestId}/reject"
  },
  "remote.peers.disconnect": {
    "method": "POST",
    "path": "/api/remote/peers/{peerId}/disconnect"
  },
  "remote.peers.invoke": {
    "method": "POST",
    "path": "/api/remote/peers/{peerId}/invoke"
  },
  "remote.peers.list": {
    "method": "GET",
    "path": "/api/remote/peers"
  },
  "remote.peers.token.revoke": {
    "method": "POST",
    "path": "/api/remote/peers/{peerId}/token/revoke"
  },
  "remote.peers.token.rotate": {
    "method": "POST",
    "path": "/api/remote/peers/{peerId}/token/rotate"
  },
  "remote.snapshot": {
    "method": "GET",
    "path": "/api/remote"
  },
  "remote.work.cancel": {
    "method": "POST",
    "path": "/api/remote/work/{workId}/cancel"
  },
  "remote.work.list": {
    "method": "GET",
    "path": "/api/remote/work"
  },
  "review.snapshot": {
    "method": "GET",
    "path": "/api/review"
  },
  "routes.bindings.create": {
    "method": "POST",
    "path": "/api/routes/bindings"
  },
  "routes.bindings.delete": {
    "method": "DELETE",
    "path": "/api/routes/bindings/{bindingId}"
  },
  "routes.bindings.list": {
    "method": "GET",
    "path": "/api/routes/bindings"
  },
  "routes.bindings.update": {
    "method": "PATCH",
    "path": "/api/routes/bindings/{bindingId}"
  },
  "routes.snapshot": {
    "method": "GET",
    "path": "/api/routes"
  },
  "surfaces.list": {
    "method": "GET",
    "path": "/api/surfaces"
  },
  "runtime.metrics.get": {
    "method": "GET",
    "path": "/api/runtime/metrics"
  },
  "scheduler.capacity": {
    "method": "GET",
    "path": "/api/runtime/scheduler"
  },
  "services.install": {
    "method": "POST",
    "path": "/api/service/install"
  },
  "services.restart": {
    "method": "POST",
    "path": "/api/service/restart"
  },
  "services.start": {
    "method": "POST",
    "path": "/api/service/start"
  },
  "services.status": {
    "method": "GET",
    "path": "/api/service/status"
  },
  "services.stop": {
    "method": "POST",
    "path": "/api/service/stop"
  },
  "services.uninstall": {
    "method": "POST",
    "path": "/api/service/uninstall"
  },
  "sessions.close": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/close"
  },
  "sessions.contextUsage.get": {
    "method": "GET",
    "path": "/api/sessions/{sessionId}/context-usage"
  },
  "sessions.create": {
    "method": "POST",
    "path": "/api/sessions"
  },
  "sessions.delete": {
    "method": "DELETE",
    "path": "/api/sessions/{sessionId}"
  },
  "sessions.detach": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/detach"
  },
  "sessions.followUp": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/follow-up"
  },
  "sessions.get": {
    "method": "GET",
    "path": "/api/sessions/{sessionId}"
  },
  "sessions.inputs.cancel": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/inputs/{inputId}/cancel"
  },
  "sessions.inputs.deliver": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/inputs/{inputId}/deliver"
  },
  "sessions.inputs.list": {
    "method": "GET",
    "path": "/api/sessions/{sessionId}/inputs"
  },
  "sessions.integration.snapshot": {
    "method": "GET",
    "path": "/api/session"
  },
  "sessions.list": {
    "method": "GET",
    "path": "/api/sessions"
  },
  "sessions.messages.create": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/messages"
  },
  "sessions.messages.list": {
    "method": "GET",
    "path": "/api/sessions/{sessionId}/messages"
  },
  "sessions.permissionMode.get": {
    "method": "GET",
    "path": "/api/sessions/{sessionId}/permission-mode"
  },
  "sessions.permissionMode.set": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/permission-mode"
  },
  "sessions.register": {
    "method": "POST",
    "path": "/api/sessions/register"
  },
  "sessions.reopen": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/reopen"
  },
  "sessions.steer": {
    "method": "POST",
    "path": "/api/sessions/{sessionId}/steer"
  },
  "security.settings": {
    "method": "GET",
    "path": "/api/security-settings"
  },
  "settings.snapshot": {
    "method": "GET",
    "path": "/api/settings"
  },
  "skills.create": {
    "method": "POST",
    "path": "/api/skills"
  },
  "skills.delete": {
    "method": "DELETE",
    "path": "/api/skills/{name}"
  },
  "skills.get": {
    "method": "GET",
    "path": "/api/skills/{name}"
  },
  "skills.list": {
    "method": "GET",
    "path": "/api/skills"
  },
  "skills.update": {
    "method": "POST",
    "path": "/api/skills/{name}/update"
  },
  "tasks.cancel": {
    "method": "POST",
    "path": "/api/tasks/{taskId}/cancel"
  },
  "tasks.create": {
    "method": "POST",
    "path": "/task"
  },
  "tasks.get": {
    "method": "GET",
    "path": "/api/tasks/{taskId}"
  },
  "tasks.list": {
    "method": "GET",
    "path": "/api/tasks"
  },
  "tasks.retry": {
    "method": "POST",
    "path": "/api/tasks/{taskId}/retry"
  },
  "tasks.status": {
    "method": "GET",
    "path": "/task/{agentId}"
  },
  "telemetry.errors.list": {
    "method": "GET",
    "path": "/api/v1/telemetry/errors"
  },
  "telemetry.events.list": {
    "method": "GET",
    "path": "/api/v1/telemetry/events"
  },
  "telemetry.metrics.get": {
    "method": "GET",
    "path": "/api/v1/telemetry/metrics"
  },
  "telemetry.otlp.logs": {
    "method": "GET",
    "path": "/api/v1/telemetry/otlp/v1/logs"
  },
  "telemetry.otlp.metrics": {
    "method": "GET",
    "path": "/api/v1/telemetry/otlp/v1/metrics"
  },
  "telemetry.otlp.traces": {
    "method": "GET",
    "path": "/api/v1/telemetry/otlp/v1/traces"
  },
  "telemetry.snapshot": {
    "method": "GET",
    "path": "/api/v1/telemetry"
  },
  "telemetry.stream": {
    "method": "GET",
    "path": "/api/v1/telemetry/stream"
  },
  "telemetry.traces.list": {
    "method": "GET",
    "path": "/api/v1/telemetry/traces"
  },
  "voice.providers.list": {
    "method": "GET",
    "path": "/api/voice/providers"
  },
  "voice.realtime.session": {
    "method": "POST",
    "path": "/api/voice/realtime/session"
  },
  "voice.status": {
    "method": "GET",
    "path": "/api/voice"
  },
  "voice.stt": {
    "method": "POST",
    "path": "/api/voice/stt"
  },
  "voice.tts": {
    "method": "POST",
    "path": "/api/voice/tts"
  },
  "voice.tts.stream": {
    "method": "POST",
    "path": "/api/voice/tts/stream"
  },
  "voice.voices.list": {
    "method": "GET",
    "path": "/api/voice/voices"
  },
  "watchers.create": {
    "method": "POST",
    "path": "/api/watchers"
  },
  "watchers.delete": {
    "method": "DELETE",
    "path": "/api/watchers/{watcherId}"
  },
  "watchers.list": {
    "method": "GET",
    "path": "/api/watchers"
  },
  "watchers.run": {
    "method": "POST",
    "path": "/api/watchers/{watcherId}/run"
  },
  "watchers.start": {
    "method": "POST",
    "path": "/api/watchers/{watcherId}/start"
  },
  "watchers.stop": {
    "method": "POST",
    "path": "/api/watchers/{watcherId}/stop"
  },
  "watchers.update": {
    "method": "PATCH",
    "path": "/api/watchers/{watcherId}"
  },
  "web_search.providers.list": {
    "method": "GET",
    "path": "/api/web-search/providers"
  },
  "web_search.query": {
    "method": "POST",
    "path": "/api/web-search/query"
  },
  "workspaces.registrations.add": {
    "method": "POST",
    "path": "/api/workspaces/registrations"
  },
  "workspaces.registrations.list": {
    "method": "GET",
    "path": "/api/workspaces/registrations"
  },
  "workspaces.registrations.remove": {
    "method": "DELETE",
    "path": "/api/workspaces/registrations"
  },
  "workspaces.resolve": {
    "method": "POST",
    "path": "/api/workspaces/resolve"
  },
  "worktrees.snapshot": {
    "method": "GET",
    "path": "/api/worktrees"
  }
} as const;

/**
 * Methods reachable ONLY through the generic gateway-method invoke endpoint
 * (transport ['ws'], no http binding) — the webui posts these to
 * /api/control-plane/methods/{methodId}/invoke.
 */
export const WEBUI_WS_INVOKE_METHOD_IDS: readonly string[] = [
  "acp.agents.list",
  "acp.sessions.create",
  "channels.test.send",
  "checkpoints.create",
  "checkpoints.diff",
  "checkpoints.list",
  "checkpoints.restore",
  "checkpoints.restorePreview",
  "checkpoints.revertHunk",
  "checkpoints.revertHunkPreview",
  "cost.attribution.get",
  "flags.graduation.report",
  "fleet.archive",
  "fleet.archived.list",
  "fleet.archiveFinished",
  "fleet.attempts.judge",
  "fleet.attempts.list",
  "fleet.attempts.pick",
  "fleet.conflicts.list",
  "fleet.conflicts.resolve",
  "fleet.list",
  "fleet.snapshot",
  "fleet.unarchive",
  "pairing.handoff.complete",
  "pairing.handoff.create",
  "pairing.posture.get",
  "pairing.tokens.create",
  "pairing.tokens.delete",
  "pairing.tokens.list",
  "pairing.tokens.migrate",
  "pairing.tokens.rename",
  "pairing.tokens.revokeShared",
  "permissions.rules.delete",
  "permissions.rules.list",
  "push.subscriptions.create",
  "push.subscriptions.delete",
  "push.subscriptions.list",
  "push.subscriptions.reconcile",
  "push.subscriptions.verify",
  "push.vapid.get",
  "quota.fanout.get",
  "quota.snapshot.get",
  "tailscale.get",
  "tailscale.serve.run",
  "rewind.apply",
  "rewind.plan",
  "sessions.changes.get",
  "sessions.search",
  "worktrees.discard",
  "worktrees.setup.run"
] as const;

/** methodId -> disposition for every cataloged method. */
export const WEBUI_METHOD_DISPOSITION: Readonly<Record<string, WebuiMethodDisposition>> = {
  "accounts.snapshot": "rest",
  "acp.agents.list": "ws-invoke",
  "acp.sessions.create": "ws-invoke",
  "approvals.approve": "rest",
  "approvals.cancel": "rest",
  "approvals.claim": "rest",
  "approvals.deny": "rest",
  "approvals.list": "rest",
  "artifacts.content.get": "rest",
  "artifacts.create": "rest",
  "artifacts.get": "rest",
  "artifacts.list": "rest",
  "local_auth.bootstrap.delete": "rest",
  "local_auth.sessions.delete": "rest",
  "local_auth.status": "rest",
  "local_auth.users.create": "rest",
  "local_auth.users.delete": "rest",
  "local_auth.users.password.rotate": "rest",
  "automation.heartbeat.list": "rest",
  "automation.heartbeat.run": "rest",
  "automation.integration.snapshot": "rest",
  "automation.jobs.create": "rest",
  "automation.jobs.delete": "rest",
  "automation.jobs.disable": "rest",
  "automation.jobs.enable": "rest",
  "automation.jobs.list": "rest",
  "automation.jobs.run": "rest",
  "automation.jobs.update": "rest",
  "automation.runs.cancel": "rest",
  "automation.runs.get": "rest",
  "automation.runs.list": "rest",
  "automation.runs.retry": "rest",
  "automation.schedules.create": "rest",
  "automation.schedules.delete": "rest",
  "automation.schedules.disable": "rest",
  "automation.schedules.enable": "rest",
  "automation.schedules.list": "rest",
  "automation.schedules.run": "rest",
  "calendar.events.create": "rest",
  "calendar.events.get": "rest",
  "calendar.events.list": "rest",
  "calendar.ics.export": "rest",
  "calendar.ics.import": "rest",
  "channels.accounts.action.default": "rest",
  "channels.accounts.action.named": "rest",
  "channels.accounts.get": "rest",
  "channels.accounts.list": "rest",
  "channels.accounts.surface.list": "rest",
  "channels.actions.invoke": "rest",
  "channels.actions.list": "rest",
  "channels.actions.surface.list": "rest",
  "channels.agent_tools.list": "rest",
  "channels.agent_tools.surface.list": "rest",
  "channels.allowlist.edit": "rest",
  "channels.allowlist.resolve": "rest",
  "channels.authorize": "rest",
  "channels.capabilities.list": "rest",
  "channels.capabilities.surface.list": "rest",
  "channels.directory.query": "rest",
  "channels.doctor.get": "rest",
  "channels.drafts.delete": "rest",
  "channels.drafts.get": "rest",
  "channels.drafts.list": "rest",
  "channels.drafts.save": "rest",
  "channels.inbox.list": "rest",
  "channels.lifecycle.get": "rest",
  "channels.policies.audit": "rest",
  "channels.policies.list": "rest",
  "channels.policies.update": "rest",
  "channels.profiles.delete": "rest",
  "channels.profiles.get": "rest",
  "channels.profiles.list": "rest",
  "channels.profiles.set": "rest",
  "channels.repairs.list": "rest",
  "channels.routing.assign": "rest",
  "channels.routing.delete": "rest",
  "channels.routing.list": "rest",
  "channels.setup.get": "rest",
  "channels.status": "rest",
  "channels.targets.resolve": "rest",
  "channels.test.send": "ws-invoke",
  "channels.tools.invoke": "rest",
  "channels.tools.list": "rest",
  "channels.tools.surface.list": "rest",
  "checkin.config.get": "rest",
  "checkin.config.set": "rest",
  "checkin.receipts.list": "rest",
  "checkin.run": "rest",
  "checkpoints.create": "ws-invoke",
  "checkpoints.diff": "ws-invoke",
  "checkpoints.list": "ws-invoke",
  "checkpoints.restore": "ws-invoke",
  "checkpoints.restorePreview": "ws-invoke",
  "checkpoints.revertHunk": "ws-invoke",
  "checkpoints.revertHunkPreview": "ws-invoke",
  "ci.status": "rest",
  "ci.watches.create": "rest",
  "ci.watches.delete": "rest",
  "ci.watches.list": "rest",
  "ci.watches.run": "rest",
  "companion.chat.events.stream": "rest",
  "companion.chat.messages.create": "rest",
  "companion.chat.messages.edit": "rest",
  "companion.chat.messages.list": "rest",
  "companion.chat.messages.retry": "rest",
  "companion.chat.messages.steer": "rest",
  "companion.chat.sessions.close": "rest",
  "companion.chat.sessions.create": "rest",
  "companion.chat.sessions.delete": "rest",
  "companion.chat.sessions.get": "rest",
  "companion.chat.sessions.list": "rest",
  "companion.chat.sessions.update": "rest",
  "companion.chat.turns.cancel": "rest",
  "config.get": "rest",
  "config.set": "rest",
  "credentials.get": "rest",
  "continuity.snapshot": "rest",
  "control.auth.current": "rest",
  "control.auth.login": "rest",
  "control.clients.list": "rest",
  "control.contract": "rest",
  "control.events.catalog": "rest",
  "control.events.stream": "rest",
  "control.messages.list": "rest",
  "control.methods.get": "rest",
  "control.methods.list": "rest",
  "control.snapshot": "rest",
  "control.status": "rest",
  "control.web": "rest",
  "cost.attribution.get": "ws-invoke",
  "deliveries.get": "rest",
  "deliveries.list": "rest",
  "email.draft.create": "rest",
  "email.inbox.list": "rest",
  "email.inbox.read": "rest",
  "email.send": "rest",
  "flags.graduation.report": "ws-invoke",
  "fleet.archive": "ws-invoke",
  "fleet.archived.list": "ws-invoke",
  "fleet.archiveFinished": "ws-invoke",
  "fleet.attempts.judge": "ws-invoke",
  "fleet.attempts.list": "ws-invoke",
  "fleet.attempts.pick": "ws-invoke",
  "fleet.conflicts.list": "ws-invoke",
  "fleet.conflicts.resolve": "ws-invoke",
  "fleet.list": "ws-invoke",
  "fleet.snapshot": "ws-invoke",
  "fleet.unarchive": "ws-invoke",
  "health.snapshot": "rest",
  "intelligence.snapshot": "rest",
  "homeassistant.homeGraph.askHomeGraph": "rest",
  "homeassistant.homeGraph.browse": "rest",
  "homeassistant.homeGraph.export": "rest",
  "homeassistant.homeGraph.generateHomeGraphPacket": "rest",
  "homeassistant.homeGraph.generateRoomPage": "rest",
  "homeassistant.homeGraph.import": "rest",
  "homeassistant.homeGraph.ingestHomeGraphArtifact": "rest",
  "homeassistant.homeGraph.ingestHomeGraphNote": "rest",
  "homeassistant.homeGraph.ingestHomeGraphUrl": "rest",
  "homeassistant.homeGraph.linkHomeGraphKnowledge": "rest",
  "homeassistant.homeGraph.listHomeGraphIssues": "rest",
  "homeassistant.homeGraph.map": "rest",
  "homeassistant.homeGraph.pages.list": "rest",
  "homeassistant.homeGraph.refinement.run": "rest",
  "homeassistant.homeGraph.refinement.task.cancel": "rest",
  "homeassistant.homeGraph.refinement.task.get": "rest",
  "homeassistant.homeGraph.refinement.tasks.list": "rest",
  "homeassistant.homeGraph.refreshDevicePassport": "rest",
  "homeassistant.homeGraph.reindex": "rest",
  "homeassistant.homeGraph.reset": "rest",
  "homeassistant.homeGraph.reviewHomeGraphFact": "rest",
  "homeassistant.homeGraph.sources.list": "rest",
  "homeassistant.homeGraph.status": "rest",
  "homeassistant.homeGraph.syncHomeGraph": "rest",
  "homeassistant.homeGraph.unlinkHomeGraphKnowledge": "rest",
  "knowledge.ask": "rest",
  "knowledge.candidate.decide": "rest",
  "knowledge.candidate.get": "rest",
  "knowledge.candidates.list": "rest",
  "knowledge.connector.doctor": "rest",
  "knowledge.connector.get": "rest",
  "knowledge.connectors.list": "rest",
  "knowledge.extraction.get": "rest",
  "knowledge.extractions.list": "rest",
  "knowledge.graphql.execute": "rest",
  "knowledge.graphql.schema": "rest",
  "knowledge.ingest.artifact": "rest",
  "knowledge.ingest.bookmarks": "rest",
  "knowledge.ingest.browserHistory": "rest",
  "knowledge.ingest.connector": "rest",
  "knowledge.ingest.url": "rest",
  "knowledge.ingest.urls": "rest",
  "knowledge.issue.review": "rest",
  "knowledge.issues.list": "rest",
  "knowledge.item.get": "rest",
  "knowledge.job-runs.list": "rest",
  "knowledge.job.get": "rest",
  "knowledge.job.run": "rest",
  "knowledge.jobs.list": "rest",
  "knowledge.lint": "rest",
  "knowledge.map": "rest",
  "knowledge.nodes.list": "rest",
  "knowledge.packet": "rest",
  "knowledge.projection.materialize": "rest",
  "knowledge.projection.render": "rest",
  "knowledge.projections.list": "rest",
  "knowledge.refinement.run": "rest",
  "knowledge.refinement.task.cancel": "rest",
  "knowledge.refinement.task.get": "rest",
  "knowledge.refinement.tasks.list": "rest",
  "knowledge.reindex": "rest",
  "knowledge.report.get": "rest",
  "knowledge.reports.list": "rest",
  "knowledge.schedule.delete": "rest",
  "knowledge.schedule.enable": "rest",
  "knowledge.schedule.get": "rest",
  "knowledge.schedule.save": "rest",
  "knowledge.schedules.list": "rest",
  "knowledge.search": "rest",
  "knowledge.source.extraction.get": "rest",
  "knowledge.sources.list": "rest",
  "knowledge.status": "rest",
  "knowledge.usage.list": "rest",
  "projectPlanning.decisions.list": "rest",
  "projectPlanning.decisions.record": "rest",
  "projectPlanning.evaluate": "rest",
  "projectPlanning.language.get": "rest",
  "projectPlanning.language.upsert": "rest",
  "projectPlanning.state.get": "rest",
  "projectPlanning.state.upsert": "rest",
  "projectPlanning.status": "rest",
  "projectPlanning.workPlan.clearCompleted": "rest",
  "projectPlanning.workPlan.snapshot": "rest",
  "projectPlanning.workPlan.task.create": "rest",
  "projectPlanning.workPlan.task.delete": "rest",
  "projectPlanning.workPlan.task.get": "rest",
  "projectPlanning.workPlan.task.status": "rest",
  "projectPlanning.workPlan.task.update": "rest",
  "projectPlanning.workPlan.tasks.list": "rest",
  "projectPlanning.workPlan.tasks.reorder": "rest",
  "mcp.config.get": "rest",
  "mcp.config.reload": "rest",
  "mcp.servers.list": "rest",
  "mcp.servers.remove": "rest",
  "mcp.servers.upsert": "rest",
  "mcp.tools.list": "rest",
  "media.analyze": "rest",
  "media.generate": "rest",
  "media.providers.list": "rest",
  "media.transform": "rest",
  "multimodal.analyze": "rest",
  "multimodal.packet": "rest",
  "multimodal.providers.list": "rest",
  "multimodal.status": "rest",
  "multimodal.writeback": "rest",
  "memory.doctor": "rest",
  "memory.embeddings.default.set": "rest",
  "memory.projections.get": "rest",
  "memory.projections.list": "rest",
  "memory.records.add": "rest",
  "memory.records.delete": "rest",
  "memory.records.export": "rest",
  "memory.records.get": "rest",
  "memory.records.import": "rest",
  "memory.records.links.add": "rest",
  "memory.records.links.list": "rest",
  "memory.records.list": "rest",
  "memory.records.search": "rest",
  "memory.records.search-semantic": "rest",
  "memory.records.update": "rest",
  "memory.records.update-review": "rest",
  "memory.review-queue": "rest",
  "memory.vector.rebuild": "rest",
  "memory.vector.stats": "rest",
  "pairing.handoff.complete": "ws-invoke",
  "pairing.handoff.create": "ws-invoke",
  "pairing.posture.get": "ws-invoke",
  "pairing.tokens.create": "ws-invoke",
  "pairing.tokens.delete": "ws-invoke",
  "pairing.tokens.list": "ws-invoke",
  "pairing.tokens.migrate": "ws-invoke",
  "pairing.tokens.rename": "ws-invoke",
  "pairing.tokens.revokeShared": "ws-invoke",
  "panels.list": "rest",
  "panels.open": "rest",
  "permissions.rules.delete": "ws-invoke",
  "permissions.rules.list": "ws-invoke",
  "principals.create": "rest",
  "principals.delete": "rest",
  "principals.get": "rest",
  "principals.list": "rest",
  "principals.resolve": "rest",
  "principals.update": "rest",
  "providers.get": "rest",
  "providers.list": "rest",
  "providers.usage.get": "rest",
  "push.subscriptions.create": "ws-invoke",
  "push.subscriptions.delete": "ws-invoke",
  "push.subscriptions.list": "ws-invoke",
  "push.subscriptions.reconcile": "ws-invoke",
  "push.subscriptions.verify": "ws-invoke",
  "push.vapid.get": "ws-invoke",
  "quota.fanout.get": "ws-invoke",
  "quota.snapshot.get": "ws-invoke",
  "stepup.challenge.mint": "rest",
  "stepup.credentials.register": "rest",
  "remote.node_host.contract": "rest",
  "remote.pair.requests.approve": "rest",
  "remote.pair.requests.list": "rest",
  "remote.pair.requests.reject": "rest",
  "remote.peers.disconnect": "rest",
  "remote.peers.invoke": "rest",
  "remote.peers.list": "rest",
  "remote.peers.token.revoke": "rest",
  "remote.peers.token.rotate": "rest",
  "remote.snapshot": "rest",
  "remote.work.cancel": "rest",
  "remote.work.list": "rest",
  "tailscale.get": "ws-invoke",
  "tailscale.serve.run": "ws-invoke",
  "review.snapshot": "rest",
  "rewind.apply": "ws-invoke",
  "rewind.plan": "ws-invoke",
  "routes.bindings.create": "rest",
  "routes.bindings.delete": "rest",
  "routes.bindings.list": "rest",
  "routes.bindings.update": "rest",
  "routes.snapshot": "rest",
  "surfaces.list": "rest",
  "runtime.metrics.get": "rest",
  "scheduler.capacity": "rest",
  "services.install": "rest",
  "services.restart": "rest",
  "services.start": "rest",
  "services.status": "rest",
  "services.stop": "rest",
  "services.uninstall": "rest",
  "sessions.changes.get": "ws-invoke",
  "sessions.close": "rest",
  "sessions.contextUsage.get": "rest",
  "sessions.create": "rest",
  "sessions.delete": "rest",
  "sessions.detach": "rest",
  "sessions.followUp": "rest",
  "sessions.get": "rest",
  "sessions.inputs.cancel": "rest",
  "sessions.inputs.deliver": "rest",
  "sessions.inputs.list": "rest",
  "sessions.integration.snapshot": "rest",
  "sessions.list": "rest",
  "sessions.messages.create": "rest",
  "sessions.messages.list": "rest",
  "sessions.permissionMode.get": "rest",
  "sessions.permissionMode.set": "rest",
  "sessions.register": "rest",
  "sessions.reopen": "rest",
  "sessions.search": "ws-invoke",
  "sessions.steer": "rest",
  "security.settings": "rest",
  "settings.snapshot": "rest",
  "skills.create": "rest",
  "skills.delete": "rest",
  "skills.get": "rest",
  "skills.list": "rest",
  "skills.update": "rest",
  "tasks.cancel": "rest",
  "tasks.create": "rest",
  "tasks.get": "rest",
  "tasks.list": "rest",
  "tasks.retry": "rest",
  "tasks.status": "rest",
  "telemetry.errors.list": "rest",
  "telemetry.events.list": "rest",
  "telemetry.metrics.get": "rest",
  "telemetry.otlp.logs": "rest",
  "telemetry.otlp.metrics": "rest",
  "telemetry.otlp.traces": "rest",
  "telemetry.snapshot": "rest",
  "telemetry.stream": "rest",
  "telemetry.traces.list": "rest",
  "voice.providers.list": "rest",
  "voice.realtime.session": "rest",
  "voice.status": "rest",
  "voice.stt": "rest",
  "voice.tts": "rest",
  "voice.tts.stream": "rest",
  "voice.voices.list": "rest",
  "watchers.create": "rest",
  "watchers.delete": "rest",
  "watchers.list": "rest",
  "watchers.run": "rest",
  "watchers.start": "rest",
  "watchers.stop": "rest",
  "watchers.update": "rest",
  "web_search.providers.list": "rest",
  "web_search.query": "rest",
  "workspaces.registrations.add": "rest",
  "workspaces.registrations.list": "rest",
  "workspaces.registrations.remove": "rest",
  "workspaces.resolve": "rest",
  "worktrees.discard": "ws-invoke",
  "worktrees.setup.run": "ws-invoke",
  "worktrees.snapshot": "rest"
} as const;

/**
 * Schema-valid input/output sample per method, generated from the contract's
 * own JSON Schemas (the Stage-B fixture generator). Consumers cross-check
 * their bridge types against these instead of hand-authoring fixtures.
 */
export const WEBUI_METHOD_SAMPLES: Readonly<Record<string, WebuiMethodSample>> = {
  "accounts.snapshot": {
    "input": {},
    "output": {
      "capturedAt": 0,
      "providers": [
        {
          "providerId": "sample",
          "active": false,
          "modelCount": 0,
          "configured": false,
          "oauthReady": false,
          "pendingLogin": false,
          "availableRoutes": [
            "api-key"
          ],
          "preferredRoute": "api-key",
          "activeRoute": "api-key",
          "activeRouteReason": "sample",
          "authFreshness": "healthy",
          "fallbackRoute": "api-key",
          "fallbackRisk": "sample",
          "expiresAt": 0,
          "tokenType": "sample",
          "notes": [
            "sample"
          ],
          "usageWindows": [
            {
              "label": "sample",
              "detail": "sample"
            }
          ],
          "issues": [
            "sample"
          ],
          "recommendedActions": [
            {
              "description": "sample",
              "command": {
                "name": "sample",
                "args": [
                  "sample"
                ]
              }
            }
          ],
          "routeRecords": [
            {
              "route": "api-key",
              "usable": false,
              "freshness": "healthy",
              "detail": "sample",
              "issues": [
                "sample"
              ]
            }
          ]
        }
      ],
      "configuredCount": 0,
      "issueCount": 0
    }
  },
  "acp.agents.list": {
    "input": null,
    "output": {
      "agents": [
        {
          "id": "sample",
          "title": "sample",
          "binaryPath": "sample",
          "args": [
            "sample"
          ]
        }
      ]
    }
  },
  "acp.sessions.create": {
    "input": {
      "agentId": "sample",
      "cwd": "sample",
      "title": "sample",
      "prompt": "sample"
    },
    "output": {
      "hosted": {
        "id": "sample",
        "agentId": "sample",
        "title": "sample",
        "binaryPath": "sample",
        "cwd": "sample",
        "state": "sample",
        "startedAt": 0,
        "completedAt": 0,
        "sessionId": "sample",
        "progress": "sample",
        "pendingPermission": "sample",
        "error": {
          "binary": "sample",
          "stage": "sample",
          "message": "sample"
        },
        "promptCount": 0
      },
      "started": false
    }
  },
  "approvals.approve": {
    "input": {
      "approvalId": "sample",
      "note": "sample",
      "remember": false,
      "selectedHunks": [
        0
      ],
      "rememberTier": "session",
      "reason": "sample",
      "modifiedArgs": {}
    },
    "output": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          },
          "rememberOptions": [
            {
              "tier": "session",
              "label": "sample",
              "detail": "sample"
            }
          ]
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "rememberTier": "session",
          "reason": "sample",
          "modifiedArgs": {}
        },
        "fixSessionId": "sample",
        "fixSessionError": "sample",
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      },
      "recorded": {
        "approved": false,
        "rememberTier": "session",
        "reasonStored": false,
        "modifiedArgsDelivered": false
      }
    }
  },
  "approvals.cancel": {
    "input": {
      "approvalId": "sample",
      "note": "sample",
      "remember": false
    },
    "output": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          },
          "rememberOptions": [
            {
              "tier": "session",
              "label": "sample",
              "detail": "sample"
            }
          ]
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "rememberTier": "session",
          "reason": "sample",
          "modifiedArgs": {}
        },
        "fixSessionId": "sample",
        "fixSessionError": "sample",
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      },
      "recorded": {
        "approved": false,
        "rememberTier": "session",
        "reasonStored": false,
        "modifiedArgsDelivered": false
      }
    }
  },
  "approvals.claim": {
    "input": {
      "approvalId": "sample"
    },
    "output": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          },
          "rememberOptions": [
            {
              "tier": "session",
              "label": "sample",
              "detail": "sample"
            }
          ]
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "rememberTier": "session",
          "reason": "sample",
          "modifiedArgs": {}
        },
        "fixSessionId": "sample",
        "fixSessionError": "sample",
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      },
      "recorded": {
        "approved": false,
        "rememberTier": "session",
        "reasonStored": false,
        "modifiedArgsDelivered": false
      }
    }
  },
  "approvals.deny": {
    "input": {
      "approvalId": "sample",
      "note": "sample",
      "remember": false,
      "rememberTier": "session",
      "reason": "sample"
    },
    "output": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          },
          "rememberOptions": [
            {
              "tier": "session",
              "label": "sample",
              "detail": "sample"
            }
          ]
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "rememberTier": "session",
          "reason": "sample",
          "modifiedArgs": {}
        },
        "fixSessionId": "sample",
        "fixSessionError": "sample",
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      },
      "recorded": {
        "approved": false,
        "rememberTier": "session",
        "reasonStored": false,
        "modifiedArgsDelivered": false
      }
    }
  },
  "approvals.list": {
    "input": {},
    "output": {
      "awaitingDecision": false,
      "mode": "default",
      "lastDecision": {
        "callId": "sample",
        "toolName": "sample",
        "category": "read",
        "machineState": "collect_rules",
        "outcome": "approved",
        "reason": "config_allow",
        "sourceLayer": "config_policy",
        "persisted": false,
        "classification": "sample",
        "riskLevel": "low",
        "summary": "sample",
        "decidedAt": 0
      },
      "approvalCount": 0,
      "denialCount": 0,
      "cachedChecks": 0,
      "totalChecks": 0,
      "approvals": [
        {
          "id": "sample",
          "callId": "sample",
          "sessionId": "sample",
          "routeId": "sample",
          "status": "pending",
          "request": {
            "callId": "sample",
            "tool": "sample",
            "args": {},
            "category": "read",
            "analysis": {
              "classification": "sample",
              "riskLevel": "low",
              "summary": "sample",
              "reasons": [
                "sample"
              ],
              "target": "sample",
              "targetKind": "command",
              "surface": "filesystem",
              "blastRadius": "local",
              "sideEffects": [
                "sample"
              ],
              "host": "sample"
            },
            "workingDirectory": "sample",
            "attribution": {
              "kind": "background-agent",
              "agentId": "sample",
              "template": "sample"
            },
            "rememberOptions": [
              {
                "tier": "session",
                "label": "sample",
                "detail": "sample"
              }
            ]
          },
          "createdAt": 0,
          "updatedAt": 0,
          "claimedBy": "sample",
          "claimedAt": 0,
          "resolvedAt": 0,
          "resolvedBy": "sample",
          "decision": {
            "approved": false,
            "remember": false,
            "rememberTier": "session",
            "reason": "sample",
            "modifiedArgs": {}
          },
          "fixSessionId": "sample",
          "fixSessionError": "sample",
          "metadata": {},
          "audit": [
            {
              "id": "sample",
              "action": "created",
              "actor": "sample",
              "actorSurface": "sample",
              "createdAt": 0,
              "note": "sample"
            }
          ]
        }
      ]
    }
  },
  "artifacts.content.get": {
    "input": {
      "artifactId": "sample",
      "download": "sample"
    },
    "output": {
      "contentType": "sample",
      "contentLength": 0
    }
  },
  "artifacts.create": {
    "input": {
      "kind": "sample",
      "mimeType": "sample",
      "filename": "sample",
      "dataBase64": "sample",
      "text": "sample",
      "path": "sample",
      "uri": "sample",
      "allowPrivateHosts": false,
      "retentionMs": 0,
      "metadata": {}
    },
    "output": {
      "artifact": {
        "id": "sample",
        "kind": "sample",
        "mimeType": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "createdAt": 0,
        "expiresAt": 0,
        "sourceUri": "sample",
        "acquisitionMode": "sample",
        "fetchMode": "sample",
        "metadata": {}
      }
    }
  },
  "artifacts.get": {
    "input": {
      "artifactId": "sample"
    },
    "output": {
      "artifact": {
        "id": "sample",
        "kind": "sample",
        "mimeType": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "createdAt": 0,
        "expiresAt": 0,
        "sourceUri": "sample",
        "acquisitionMode": "sample",
        "fetchMode": "sample",
        "metadata": {}
      }
    }
  },
  "artifacts.list": {
    "input": {},
    "output": {
      "artifacts": [
        {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "local_auth.bootstrap.delete": {
    "input": {},
    "output": {
      "removed": false
    }
  },
  "local_auth.sessions.delete": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "revoked": false
    }
  },
  "local_auth.status": {
    "input": {},
    "output": {
      "userStorePath": "sample",
      "bootstrapCredentialPath": "sample",
      "bootstrapCredentialPresent": false,
      "userCount": 0,
      "sessionCount": 0,
      "users": [
        {
          "username": "sample",
          "roles": [
            "sample"
          ]
        }
      ],
      "sessions": [
        {
          "tokenFingerprint": "sample",
          "username": "sample",
          "expiresAt": 0
        }
      ]
    }
  },
  "local_auth.users.create": {
    "input": {
      "username": "sample",
      "password": "sample"
    },
    "output": {
      "user": {
        "username": "sample",
        "roles": [
          "sample"
        ]
      }
    }
  },
  "local_auth.users.delete": {
    "input": {
      "username": "sample"
    },
    "output": {
      "deleted": false
    }
  },
  "local_auth.users.password.rotate": {
    "input": {
      "password": "sample"
    },
    "output": {
      "rotated": false
    }
  },
  "automation.heartbeat.list": {
    "input": {},
    "output": {
      "pending": [
        {
          "jobId": "sample",
          "jobName": "sample",
          "trigger": "scheduled",
          "dueRun": false,
          "attempt": 0,
          "queuedAt": 0,
          "reason": "sample"
        }
      ]
    }
  },
  "automation.heartbeat.run": {
    "input": {
      "source": "sample"
    },
    "output": {
      "processed": [
        {
          "id": "sample",
          "jobId": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "queued",
          "agentId": "sample",
          "triggeredBy": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "scheduleKind": "at",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "durationMs": 0,
          "forceRun": false,
          "dueRun": false,
          "attempt": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "route": {
            "id": "sample",
            "kind": "session",
            "surfaceKind": "tui",
            "surfaceId": "sample",
            "externalId": "sample",
            "sessionPolicy": "create-or-bind",
            "threadPolicy": "preserve",
            "deliveryGuarantee": "best-effort",
            "threadId": "sample",
            "channelId": "sample",
            "sessionId": "sample",
            "jobId": "sample",
            "runId": "sample",
            "title": "sample",
            "lastSeenAt": 0,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "continuationMode": "spawn",
          "executionIntent": {
            "mode": "spawn",
            "targetKind": "isolated"
          },
          "deliveryIds": [
            "sample"
          ],
          "deliveryAttempts": [
            {
              "id": "sample",
              "runId": "sample",
              "jobId": "sample",
              "target": {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              },
              "status": "pending",
              "startedAt": 0,
              "endedAt": 0,
              "error": "sample",
              "responseId": "sample"
            }
          ],
          "modelId": "sample",
          "providerId": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "result": "sample",
          "error": "sample",
          "cancelledReason": "sample",
          "metadata": {}
        }
      ],
      "failed": [
        {
          "jobId": "sample",
          "error": "sample"
        }
      ],
      "pending": [
        {
          "jobId": "sample",
          "jobName": "sample",
          "trigger": "scheduled",
          "dueRun": false,
          "attempt": 0,
          "queuedAt": 0,
          "reason": "sample"
        }
      ],
      "checkedAt": 0
    }
  },
  "automation.integration.snapshot": {
    "input": {},
    "output": {
      "totals": {
        "jobs": 0,
        "enabled": 0,
        "paused": 0,
        "runs": 0
      },
      "jobs": [
        {
          "id": "sample",
          "name": "sample",
          "enabled": false,
          "status": "enabled",
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "nextRunAt": 0,
          "lastRunAt": 0,
          "runCount": 0,
          "failureCount": 0
        }
      ],
      "recentRuns": [
        {
          "id": "sample",
          "jobId": "sample",
          "status": "sample",
          "trigger": "sample",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "agentId": "sample",
          "error": "sample"
        }
      ]
    }
  },
  "automation.jobs.create": {
    "input": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "prompt": "sample",
      "kind": "sample",
      "cron": "sample",
      "every": "sample",
      "at": "sample",
      "timezone": "sample",
      "staggerMs": 0,
      "model": "sample",
      "provider": "sample",
      "fallbackModels": [
        "sample"
      ],
      "executionIntent": {
        "riskClass": "safe",
        "requiresApproval": false,
        "networkPolicy": "inherit",
        "filesystemPolicy": "inherit"
      },
      "template": "sample",
      "target": {
        "kind": "isolated",
        "sessionId": "sample",
        "routeId": "sample",
        "threadId": "sample",
        "channelId": "sample",
        "surfaceKind": "tui",
        "pinnedSessionId": "sample",
        "preserveThread": false,
        "createIfMissing": false
      },
      "reasoningEffort": "sample",
      "thinking": "sample",
      "wakeMode": "sample",
      "timeoutMs": 0,
      "toolAllowlist": [
        "sample"
      ],
      "autoApprove": false,
      "allowUnsafeExternalContent": false,
      "externalContentSource": "sample",
      "lightContext": false,
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "enabled": false,
      "deleteAfterRun": false,
      "metadata": {}
    },
    "output": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "createdAt": 0,
      "updatedAt": 0,
      "status": "enabled",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "execution": {
        "prompt": "sample",
        "template": "sample",
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "modelProvider": "sample",
        "modelId": "sample",
        "fallbackModels": [
          "sample"
        ],
        "routing": {
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ]
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "reasoningEffort": "instant",
        "thinking": "sample",
        "wakeMode": "next-heartbeat",
        "timeoutMs": 0,
        "maxAttempts": 0,
        "toolAllowlist": [
          "sample"
        ],
        "autoApprove": false,
        "sandboxMode": "inherit",
        "allowUnsafeExternalContent": false,
        "externalContentSource": "gmail",
        "lightContext": false
      },
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "source": {
        "id": "sample",
        "kind": "schedule",
        "label": "sample",
        "surfaceKind": "tui",
        "routeId": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "lastSeenAt": 0,
        "metadata": {}
      },
      "nextRunAt": 0,
      "lastRunAt": 0,
      "lastRunId": "sample",
      "runCount": 0,
      "successCount": 0,
      "failureCount": 0,
      "pausedReason": "sample",
      "deleteAfterRun": false,
      "archivedAt": 0,
      "metadata": {}
    }
  },
  "automation.jobs.delete": {
    "input": {
      "jobId": "sample"
    },
    "output": {
      "removed": false,
      "id": "sample"
    }
  },
  "automation.jobs.disable": {
    "input": {
      "jobId": "sample"
    },
    "output": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.jobs.enable": {
    "input": {
      "jobId": "sample"
    },
    "output": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.jobs.list": {
    "input": {
      "limit": 0,
      "cursor": "sample"
    },
    "output": {
      "jobs": [
        {
          "id": "sample",
          "name": "sample",
          "description": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "enabled",
          "enabled": false,
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "delivery": {
            "mode": "none",
            "targets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "fallbackTargets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "includeSummary": false,
            "includeTranscript": false,
            "includeLinks": false,
            "replyToRouteId": "sample"
          },
          "failure": {
            "action": "retry",
            "maxConsecutiveFailures": 0,
            "cooldownMs": 0,
            "retryPolicy": {
              "maxAttempts": 0,
              "delayMs": 0,
              "strategy": "fixed",
              "maxDelayMs": 0,
              "jitterMs": 0
            },
            "deadLetterRouteId": "sample",
            "disableAfterFailures": false,
            "notifyRouteId": "sample"
          },
          "source": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "nextRunAt": 0,
          "lastRunAt": 0,
          "lastRunId": "sample",
          "runCount": 0,
          "successCount": 0,
          "failureCount": 0,
          "pausedReason": "sample",
          "deleteAfterRun": false,
          "archivedAt": 0,
          "metadata": {}
        }
      ],
      "emptyState": {
        "title": "sample",
        "body": "sample"
      }
    }
  },
  "automation.jobs.run": {
    "input": {
      "jobId": "sample"
    },
    "output": {
      "jobId": "sample",
      "runId": "sample",
      "agentId": "sample",
      "status": "sample"
    }
  },
  "automation.jobs.update": {
    "input": {
      "jobId": "sample",
      "name": "sample",
      "description": "sample",
      "prompt": "sample",
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "model": "sample",
      "provider": "sample",
      "fallbackModels": [
        "sample"
      ],
      "executionIntent": {
        "riskClass": "safe",
        "requiresApproval": false,
        "networkPolicy": "inherit",
        "filesystemPolicy": "inherit"
      },
      "template": "sample",
      "target": {
        "kind": "isolated",
        "sessionId": "sample",
        "routeId": "sample",
        "threadId": "sample",
        "channelId": "sample",
        "surfaceKind": "tui",
        "pinnedSessionId": "sample",
        "preserveThread": false,
        "createIfMissing": false
      },
      "reasoningEffort": "sample",
      "thinking": "sample",
      "wakeMode": "sample",
      "timeoutMs": 0,
      "toolAllowlist": [
        "sample"
      ],
      "autoApprove": false,
      "allowUnsafeExternalContent": false,
      "externalContentSource": "sample",
      "lightContext": false,
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "enabled": false,
      "deleteAfterRun": false,
      "metadata": {}
    },
    "output": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "createdAt": 0,
      "updatedAt": 0,
      "status": "enabled",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "execution": {
        "prompt": "sample",
        "template": "sample",
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "modelProvider": "sample",
        "modelId": "sample",
        "fallbackModels": [
          "sample"
        ],
        "routing": {
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ]
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "reasoningEffort": "instant",
        "thinking": "sample",
        "wakeMode": "next-heartbeat",
        "timeoutMs": 0,
        "maxAttempts": 0,
        "toolAllowlist": [
          "sample"
        ],
        "autoApprove": false,
        "sandboxMode": "inherit",
        "allowUnsafeExternalContent": false,
        "externalContentSource": "gmail",
        "lightContext": false
      },
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "source": {
        "id": "sample",
        "kind": "schedule",
        "label": "sample",
        "surfaceKind": "tui",
        "routeId": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "lastSeenAt": 0,
        "metadata": {}
      },
      "nextRunAt": 0,
      "lastRunAt": 0,
      "lastRunId": "sample",
      "runCount": 0,
      "successCount": 0,
      "failureCount": 0,
      "pausedReason": "sample",
      "deleteAfterRun": false,
      "archivedAt": 0,
      "metadata": {}
    }
  },
  "automation.runs.cancel": {
    "input": {
      "runId": "sample"
    },
    "output": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "labels": [
          "sample"
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "status": "queued",
        "agentId": "sample",
        "triggeredBy": {
          "id": "sample",
          "kind": "schedule",
          "label": "sample",
          "surfaceKind": "tui",
          "routeId": "sample",
          "enabled": false,
          "createdAt": 0,
          "updatedAt": 0,
          "lastSeenAt": 0,
          "metadata": {}
        },
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "execution": {
          "prompt": "sample",
          "template": "sample",
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "modelProvider": "sample",
          "modelId": "sample",
          "fallbackModels": [
            "sample"
          ],
          "routing": {
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ]
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "reasoningEffort": "instant",
          "thinking": "sample",
          "wakeMode": "next-heartbeat",
          "timeoutMs": 0,
          "maxAttempts": 0,
          "toolAllowlist": [
            "sample"
          ],
          "autoApprove": false,
          "sandboxMode": "inherit",
          "allowUnsafeExternalContent": false,
          "externalContentSource": "gmail",
          "lightContext": false
        },
        "scheduleKind": "at",
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "durationMs": 0,
        "forceRun": false,
        "dueRun": false,
        "attempt": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "route": {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        },
        "continuationMode": "spawn",
        "executionIntent": {
          "mode": "spawn",
          "targetKind": "isolated"
        },
        "deliveryIds": [
          "sample"
        ],
        "deliveryAttempts": [
          {
            "id": "sample",
            "runId": "sample",
            "jobId": "sample",
            "target": {
              "kind": "none",
              "surfaceKind": "tui",
              "address": "sample",
              "routeId": "sample",
              "label": "sample"
            },
            "status": "pending",
            "startedAt": 0,
            "endedAt": 0,
            "error": "sample",
            "responseId": "sample"
          }
        ],
        "modelId": "sample",
        "providerId": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "result": "sample",
        "error": "sample",
        "cancelledReason": "sample",
        "metadata": {}
      }
    }
  },
  "automation.runs.get": {
    "input": {
      "runId": "sample"
    },
    "output": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "labels": [
          "sample"
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "status": "queued",
        "agentId": "sample",
        "triggeredBy": {
          "id": "sample",
          "kind": "schedule",
          "label": "sample",
          "surfaceKind": "tui",
          "routeId": "sample",
          "enabled": false,
          "createdAt": 0,
          "updatedAt": 0,
          "lastSeenAt": 0,
          "metadata": {}
        },
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "execution": {
          "prompt": "sample",
          "template": "sample",
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "modelProvider": "sample",
          "modelId": "sample",
          "fallbackModels": [
            "sample"
          ],
          "routing": {
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ]
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "reasoningEffort": "instant",
          "thinking": "sample",
          "wakeMode": "next-heartbeat",
          "timeoutMs": 0,
          "maxAttempts": 0,
          "toolAllowlist": [
            "sample"
          ],
          "autoApprove": false,
          "sandboxMode": "inherit",
          "allowUnsafeExternalContent": false,
          "externalContentSource": "gmail",
          "lightContext": false
        },
        "scheduleKind": "at",
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "durationMs": 0,
        "forceRun": false,
        "dueRun": false,
        "attempt": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "route": {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        },
        "continuationMode": "spawn",
        "executionIntent": {
          "mode": "spawn",
          "targetKind": "isolated"
        },
        "deliveryIds": [
          "sample"
        ],
        "deliveryAttempts": [
          {
            "id": "sample",
            "runId": "sample",
            "jobId": "sample",
            "target": {
              "kind": "none",
              "surfaceKind": "tui",
              "address": "sample",
              "routeId": "sample",
              "label": "sample"
            },
            "status": "pending",
            "startedAt": 0,
            "endedAt": 0,
            "error": "sample",
            "responseId": "sample"
          }
        ],
        "modelId": "sample",
        "providerId": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "result": "sample",
        "error": "sample",
        "cancelledReason": "sample",
        "metadata": {}
      },
      "deliveries": [
        {
          "id": "sample",
          "runId": "sample",
          "jobId": "sample",
          "target": {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          },
          "status": "pending",
          "startedAt": 0,
          "endedAt": 0,
          "error": "sample",
          "responseId": "sample"
        }
      ]
    }
  },
  "automation.runs.list": {
    "input": {
      "limit": 0,
      "cursor": "sample",
      "since": 0
    },
    "output": {
      "runs": [
        {
          "id": "sample",
          "jobId": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "queued",
          "agentId": "sample",
          "triggeredBy": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "scheduleKind": "at",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "durationMs": 0,
          "forceRun": false,
          "dueRun": false,
          "attempt": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "route": {
            "id": "sample",
            "kind": "session",
            "surfaceKind": "tui",
            "surfaceId": "sample",
            "externalId": "sample",
            "sessionPolicy": "create-or-bind",
            "threadPolicy": "preserve",
            "deliveryGuarantee": "best-effort",
            "threadId": "sample",
            "channelId": "sample",
            "sessionId": "sample",
            "jobId": "sample",
            "runId": "sample",
            "title": "sample",
            "lastSeenAt": 0,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "continuationMode": "spawn",
          "executionIntent": {
            "mode": "spawn",
            "targetKind": "isolated"
          },
          "deliveryIds": [
            "sample"
          ],
          "deliveryAttempts": [
            {
              "id": "sample",
              "runId": "sample",
              "jobId": "sample",
              "target": {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              },
              "status": "pending",
              "startedAt": 0,
              "endedAt": 0,
              "error": "sample",
              "responseId": "sample"
            }
          ],
          "modelId": "sample",
          "providerId": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "result": "sample",
          "error": "sample",
          "cancelledReason": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "automation.runs.retry": {
    "input": {
      "runId": "sample"
    },
    "output": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "labels": [
          "sample"
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "status": "queued",
        "agentId": "sample",
        "triggeredBy": {
          "id": "sample",
          "kind": "schedule",
          "label": "sample",
          "surfaceKind": "tui",
          "routeId": "sample",
          "enabled": false,
          "createdAt": 0,
          "updatedAt": 0,
          "lastSeenAt": 0,
          "metadata": {}
        },
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "execution": {
          "prompt": "sample",
          "template": "sample",
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "modelProvider": "sample",
          "modelId": "sample",
          "fallbackModels": [
            "sample"
          ],
          "routing": {
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ]
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "reasoningEffort": "instant",
          "thinking": "sample",
          "wakeMode": "next-heartbeat",
          "timeoutMs": 0,
          "maxAttempts": 0,
          "toolAllowlist": [
            "sample"
          ],
          "autoApprove": false,
          "sandboxMode": "inherit",
          "allowUnsafeExternalContent": false,
          "externalContentSource": "gmail",
          "lightContext": false
        },
        "scheduleKind": "at",
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "durationMs": 0,
        "forceRun": false,
        "dueRun": false,
        "attempt": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "route": {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        },
        "continuationMode": "spawn",
        "executionIntent": {
          "mode": "spawn",
          "targetKind": "isolated"
        },
        "deliveryIds": [
          "sample"
        ],
        "deliveryAttempts": [
          {
            "id": "sample",
            "runId": "sample",
            "jobId": "sample",
            "target": {
              "kind": "none",
              "surfaceKind": "tui",
              "address": "sample",
              "routeId": "sample",
              "label": "sample"
            },
            "status": "pending",
            "startedAt": 0,
            "endedAt": 0,
            "error": "sample",
            "responseId": "sample"
          }
        ],
        "modelId": "sample",
        "providerId": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "result": "sample",
        "error": "sample",
        "cancelledReason": "sample",
        "metadata": {}
      }
    }
  },
  "automation.schedules.create": {
    "input": {
      "name": "sample",
      "prompt": "sample",
      "kind": "sample",
      "cron": "sample",
      "every": "sample",
      "at": "sample",
      "timezone": "sample",
      "staggerMs": 0,
      "model": "sample",
      "provider": "sample",
      "fallbackModels": [
        "sample"
      ],
      "template": "sample",
      "target": {
        "kind": "isolated",
        "sessionId": "sample",
        "routeId": "sample",
        "threadId": "sample",
        "channelId": "sample",
        "surfaceKind": "tui",
        "pinnedSessionId": "sample",
        "preserveThread": false,
        "createIfMissing": false
      },
      "reasoningEffort": "sample",
      "thinking": "sample",
      "wakeMode": "sample",
      "timeoutMs": 0,
      "toolAllowlist": [
        "sample"
      ],
      "autoApprove": false,
      "allowUnsafeExternalContent": false,
      "externalContentSource": "sample",
      "lightContext": false,
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "enabled": false,
      "deleteAfterRun": false
    },
    "output": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "createdAt": 0,
      "updatedAt": 0,
      "status": "enabled",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "execution": {
        "prompt": "sample",
        "template": "sample",
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "modelProvider": "sample",
        "modelId": "sample",
        "fallbackModels": [
          "sample"
        ],
        "routing": {
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ]
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "reasoningEffort": "instant",
        "thinking": "sample",
        "wakeMode": "next-heartbeat",
        "timeoutMs": 0,
        "maxAttempts": 0,
        "toolAllowlist": [
          "sample"
        ],
        "autoApprove": false,
        "sandboxMode": "inherit",
        "allowUnsafeExternalContent": false,
        "externalContentSource": "gmail",
        "lightContext": false
      },
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "source": {
        "id": "sample",
        "kind": "schedule",
        "label": "sample",
        "surfaceKind": "tui",
        "routeId": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "lastSeenAt": 0,
        "metadata": {}
      },
      "nextRunAt": 0,
      "lastRunAt": 0,
      "lastRunId": "sample",
      "runCount": 0,
      "successCount": 0,
      "failureCount": 0,
      "pausedReason": "sample",
      "deleteAfterRun": false,
      "archivedAt": 0,
      "metadata": {}
    }
  },
  "automation.schedules.delete": {
    "input": {
      "scheduleId": "sample"
    },
    "output": {
      "removed": false,
      "id": "sample"
    }
  },
  "automation.schedules.disable": {
    "input": {
      "scheduleId": "sample"
    },
    "output": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.schedules.enable": {
    "input": {
      "scheduleId": "sample"
    },
    "output": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.schedules.list": {
    "input": {},
    "output": {
      "jobs": [
        {
          "id": "sample",
          "name": "sample",
          "description": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "enabled",
          "enabled": false,
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "delivery": {
            "mode": "none",
            "targets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "fallbackTargets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "includeSummary": false,
            "includeTranscript": false,
            "includeLinks": false,
            "replyToRouteId": "sample"
          },
          "failure": {
            "action": "retry",
            "maxConsecutiveFailures": 0,
            "cooldownMs": 0,
            "retryPolicy": {
              "maxAttempts": 0,
              "delayMs": 0,
              "strategy": "fixed",
              "maxDelayMs": 0,
              "jitterMs": 0
            },
            "deadLetterRouteId": "sample",
            "disableAfterFailures": false,
            "notifyRouteId": "sample"
          },
          "source": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "nextRunAt": 0,
          "lastRunAt": 0,
          "lastRunId": "sample",
          "runCount": 0,
          "successCount": 0,
          "failureCount": 0,
          "pausedReason": "sample",
          "deleteAfterRun": false,
          "archivedAt": 0,
          "metadata": {}
        }
      ],
      "runs": [
        {
          "id": "sample",
          "jobId": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "queued",
          "agentId": "sample",
          "triggeredBy": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "scheduleKind": "at",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "durationMs": 0,
          "forceRun": false,
          "dueRun": false,
          "attempt": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "route": {
            "id": "sample",
            "kind": "session",
            "surfaceKind": "tui",
            "surfaceId": "sample",
            "externalId": "sample",
            "sessionPolicy": "create-or-bind",
            "threadPolicy": "preserve",
            "deliveryGuarantee": "best-effort",
            "threadId": "sample",
            "channelId": "sample",
            "sessionId": "sample",
            "jobId": "sample",
            "runId": "sample",
            "title": "sample",
            "lastSeenAt": 0,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "continuationMode": "spawn",
          "executionIntent": {
            "mode": "spawn",
            "targetKind": "isolated"
          },
          "deliveryIds": [
            "sample"
          ],
          "deliveryAttempts": [
            {
              "id": "sample",
              "runId": "sample",
              "jobId": "sample",
              "target": {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              },
              "status": "pending",
              "startedAt": 0,
              "endedAt": 0,
              "error": "sample",
              "responseId": "sample"
            }
          ],
          "modelId": "sample",
          "providerId": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "result": "sample",
          "error": "sample",
          "cancelledReason": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "automation.schedules.run": {
    "input": {
      "scheduleId": "sample"
    },
    "output": {
      "jobId": "sample",
      "runId": "sample",
      "agentId": "sample",
      "status": "sample"
    }
  },
  "calendar.events.create": {
    "input": {
      "title": "sample",
      "start": "sample",
      "end": "sample",
      "description": "sample",
      "attendees": [
        "sample"
      ],
      "location": "sample",
      "calendarId": "sample",
      "confirm": false
    },
    "output": {
      "eventId": "sample",
      "uid": "sample",
      "createdAt": "sample"
    }
  },
  "calendar.events.get": {
    "input": {
      "eventId": "sample",
      "calendarId": "sample"
    },
    "output": {
      "id": "sample",
      "uid": "sample",
      "title": "sample",
      "start": "sample",
      "end": "sample",
      "location": "sample",
      "description": "sample",
      "attendees": [
        "sample"
      ],
      "recurrence": "sample"
    }
  },
  "calendar.events.list": {
    "input": {
      "calendarId": "sample",
      "from": "sample",
      "to": "sample",
      "limit": 0
    },
    "output": {
      "events": [
        {
          "id": "sample",
          "title": "sample",
          "start": "sample",
          "end": "sample",
          "location": "sample",
          "description": "sample",
          "attendees": [
            "sample"
          ]
        }
      ]
    }
  },
  "calendar.ics.export": {
    "input": {
      "calendarId": "sample",
      "from": "sample",
      "to": "sample"
    },
    "output": {
      "icsContent": "sample",
      "eventCount": 0
    }
  },
  "calendar.ics.import": {
    "input": {
      "icsContent": "sample",
      "calendarId": "sample",
      "confirm": false
    },
    "output": {
      "imported": 0,
      "eventIds": [
        "sample"
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "channels.accounts.action.default": {
    "input": {
      "accountId": "sample",
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "accountId": "sample",
      "action": "sample",
      "result": {
        "surface": "sample",
        "accountId": "sample",
        "action": "sample",
        "ok": false,
        "state": "sample",
        "authState": "sample",
        "account": {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        },
        "message": "sample",
        "login": {
          "kind": "sample",
          "url": "sample",
          "qr": "sample",
          "expiresAt": 0,
          "instructions": "sample"
        },
        "metadata": {}
      }
    }
  },
  "channels.accounts.action.named": {
    "input": {
      "accountId": "sample",
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "accountId": "sample",
      "action": "sample",
      "result": {
        "surface": "sample",
        "accountId": "sample",
        "action": "sample",
        "ok": false,
        "state": "sample",
        "authState": "sample",
        "account": {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        },
        "message": "sample",
        "login": {
          "kind": "sample",
          "url": "sample",
          "qr": "sample",
          "expiresAt": 0,
          "instructions": "sample"
        },
        "metadata": {}
      }
    }
  },
  "channels.accounts.get": {
    "input": {
      "surface": "sample",
      "accountId": "sample"
    },
    "output": {
      "id": "sample",
      "surface": "sample",
      "label": "sample",
      "enabled": false,
      "configured": false,
      "linked": false,
      "state": "sample",
      "authState": "sample",
      "accountId": "sample",
      "workspaceId": "sample",
      "secrets": [
        {
          "field": "sample",
          "label": "sample",
          "configured": false,
          "source": "sample"
        }
      ],
      "actions": [
        {
          "id": "sample",
          "label": "sample",
          "kind": "sample",
          "available": false
        }
      ],
      "metadata": {}
    }
  },
  "channels.accounts.list": {
    "input": {},
    "output": {
      "accounts": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "channels.accounts.surface.list": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "accounts": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "channels.actions.invoke": {
    "input": {
      "accountId": "sample",
      "metadata": {}
    },
    "output": {
      "actionId": "sample",
      "surface": "sample",
      "result": {}
    }
  },
  "channels.actions.list": {
    "input": {},
    "output": {
      "actions": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.actions.surface.list": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "actions": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.agent_tools.list": {
    "input": {},
    "output": {
      "tools": [
        {
          "name": "sample",
          "description": "sample",
          "parameters": {},
          "sideEffects": [
            "sample"
          ],
          "concurrency": "sample",
          "supportsProgress": false,
          "supportsStreamingOutput": false
        }
      ]
    }
  },
  "channels.agent_tools.surface.list": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "tools": [
        {
          "name": "sample",
          "description": "sample",
          "parameters": {},
          "sideEffects": [
            "sample"
          ],
          "concurrency": "sample",
          "supportsProgress": false,
          "supportsStreamingOutput": false
        }
      ]
    }
  },
  "channels.allowlist.edit": {
    "input": {
      "add": [
        "sample"
      ],
      "remove": [
        "sample"
      ],
      "groupId": "sample",
      "channelId": "sample",
      "workspaceId": "sample",
      "kind": "sample",
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "updatedPolicy": {
        "surface": "sample",
        "enabled": false,
        "requireMention": false,
        "allowDirectMessages": false,
        "allowGroupMessages": false,
        "allowThreadMessages": false,
        "dmPolicy": "sample",
        "groupPolicy": "sample",
        "allowTextCommandsWithoutMention": false,
        "allowlistUserIds": [
          "sample"
        ],
        "allowlistChannelIds": [
          "sample"
        ],
        "allowlistGroupIds": [
          "sample"
        ],
        "allowedCommands": [
          "sample"
        ],
        "groupPolicies": [
          {
            "id": "sample",
            "label": "sample",
            "groupId": "sample",
            "channelId": "sample",
            "workspaceId": "sample",
            "requireMention": false,
            "allowGroupMessages": false,
            "allowThreadMessages": false,
            "allowTextCommandsWithoutMention": false,
            "allowlistUserIds": [
              "sample"
            ],
            "allowlistChannelIds": [
              "sample"
            ],
            "allowlistGroupIds": [
              "sample"
            ],
            "allowedCommands": [
              "sample"
            ],
            "metadata": {}
          }
        ],
        "updatedAt": 0,
        "metadata": {}
      },
      "resolution": {
        "surface": "sample",
        "resolved": [
          {
            "kind": "sample",
            "input": "sample",
            "id": "sample",
            "label": "sample",
            "metadata": {}
          }
        ],
        "unresolved": [
          "sample"
        ],
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "channels.allowlist.resolve": {
    "input": {
      "add": [
        "sample"
      ],
      "remove": [
        "sample"
      ],
      "groupId": "sample",
      "channelId": "sample",
      "workspaceId": "sample",
      "kind": "sample",
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "resolved": [
        {
          "kind": "sample",
          "input": "sample",
          "id": "sample",
          "label": "sample",
          "metadata": {}
        }
      ],
      "unresolved": [
        "sample"
      ],
      "metadata": {}
    }
  },
  "channels.authorize": {
    "input": {
      "actionId": "sample",
      "actorId": "sample",
      "accountId": "sample",
      "target": "sample",
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "result": {
        "allowed": false,
        "reason": "sample",
        "account": {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        },
        "actionAvailable": false,
        "metadata": {}
      }
    }
  },
  "channels.capabilities.list": {
    "input": {},
    "output": {
      "capabilities": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "scope": "sample",
          "supported": false,
          "detail": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.capabilities.surface.list": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "capabilities": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "scope": "sample",
          "supported": false,
          "detail": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.directory.query": {
    "input": {
      "surface": "sample",
      "q": "sample",
      "scope": "sample",
      "groupId": "sample",
      "limit": 0,
      "live": false
    },
    "output": {
      "entries": [
        {
          "id": "sample",
          "surface": "sample",
          "kind": "sample",
          "label": "sample",
          "handle": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "groupId": "sample",
          "threadId": "sample",
          "parentId": "sample",
          "memberCount": 0,
          "memberIds": [
            "sample"
          ],
          "aliases": [
            "sample"
          ],
          "isSelf": false,
          "isDirect": false,
          "isGroupConversation": false,
          "searchText": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.doctor.get": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "surface": "sample",
      "accountId": "sample",
      "state": "sample",
      "summary": "sample",
      "checkedAt": 0,
      "checks": [
        {
          "id": "sample",
          "label": "sample",
          "status": "sample",
          "detail": "sample",
          "repairActionId": "sample",
          "metadata": {}
        }
      ],
      "repairActions": [
        {
          "id": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  },
  "channels.drafts.delete": {
    "input": {
      "draftId": "sample"
    },
    "output": {
      "deleted": false,
      "draftId": "sample"
    }
  },
  "channels.drafts.get": {
    "input": {
      "draftId": "sample"
    },
    "output": {
      "version": 0,
      "id": "sample",
      "createdAt": "sample",
      "updatedAt": "sample",
      "status": "sample",
      "title": "sample",
      "message": "sample",
      "channel": "sample",
      "route": "sample",
      "webhook": "sample",
      "link": "sample",
      "tags": [
        "sample"
      ],
      "sentResponseId": "sample",
      "sendError": "sample",
      "notFound": false
    }
  },
  "channels.drafts.list": {
    "input": {
      "status": "sample",
      "limit": 0
    },
    "output": {
      "drafts": [
        {
          "version": 0,
          "id": "sample",
          "createdAt": "sample",
          "updatedAt": "sample",
          "status": "sample",
          "title": "sample",
          "message": "sample",
          "channel": "sample",
          "route": "sample",
          "webhook": "sample",
          "link": "sample",
          "tags": [
            "sample"
          ],
          "sentResponseId": "sample",
          "sendError": "sample"
        }
      ],
      "total": 0
    }
  },
  "channels.drafts.save": {
    "input": {
      "version": 0,
      "id": "sample",
      "createdAt": "sample",
      "updatedAt": "sample",
      "status": "sample",
      "title": "sample",
      "message": "sample",
      "channel": "sample",
      "route": "sample",
      "webhook": "sample",
      "link": "sample",
      "tags": [
        "sample"
      ],
      "sentResponseId": "sample",
      "sendError": "sample"
    },
    "output": {
      "draft": {
        "version": 0,
        "id": "sample",
        "createdAt": "sample",
        "updatedAt": "sample",
        "status": "sample",
        "title": "sample",
        "message": "sample",
        "channel": "sample",
        "route": "sample",
        "webhook": "sample",
        "link": "sample",
        "tags": [
          "sample"
        ],
        "sentResponseId": "sample",
        "sendError": "sample"
      },
      "created": false
    }
  },
  "channels.inbox.list": {
    "input": {
      "provider": "sample",
      "limit": 0,
      "since": 0
    },
    "output": {
      "items": [
        {
          "id": "sample",
          "provider": "sample",
          "kind": "sample",
          "from": "sample",
          "fromAddress": "sample",
          "subject": "sample",
          "bodyPreview": "sample",
          "receivedAt": 0,
          "unread": false,
          "routeId": "sample",
          "threadId": "sample",
          "attachmentCount": 0
        }
      ],
      "total": 0,
      "truncated": false,
      "cursor": "sample"
    }
  },
  "channels.lifecycle.get": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "surface": "sample",
      "accountId": "sample",
      "currentVersion": 0,
      "targetVersion": 0,
      "metadata": {}
    }
  },
  "channels.policies.audit": {
    "input": {
      "limit": 0
    },
    "output": {
      "audit": [
        {
          "id": "sample",
          "surface": "sample",
          "createdAt": 0,
          "allowed": false,
          "reason": "sample",
          "userId": "sample",
          "channelId": "sample",
          "groupId": "sample",
          "threadId": "sample",
          "conversationKind": "sample",
          "matchedGroupPolicyId": "sample",
          "text": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.policies.list": {
    "input": {},
    "output": {
      "policies": [
        {
          "surface": "sample",
          "enabled": false,
          "requireMention": false,
          "allowDirectMessages": false,
          "allowGroupMessages": false,
          "allowThreadMessages": false,
          "dmPolicy": "sample",
          "groupPolicy": "sample",
          "allowTextCommandsWithoutMention": false,
          "allowlistUserIds": [
            "sample"
          ],
          "allowlistChannelIds": [
            "sample"
          ],
          "allowlistGroupIds": [
            "sample"
          ],
          "allowedCommands": [
            "sample"
          ],
          "groupPolicies": [
            {
              "id": "sample",
              "label": "sample",
              "groupId": "sample",
              "channelId": "sample",
              "workspaceId": "sample",
              "requireMention": false,
              "allowGroupMessages": false,
              "allowThreadMessages": false,
              "allowTextCommandsWithoutMention": false,
              "allowlistUserIds": [
                "sample"
              ],
              "allowlistChannelIds": [
                "sample"
              ],
              "allowlistGroupIds": [
                "sample"
              ],
              "allowedCommands": [
                "sample"
              ],
              "metadata": {}
            }
          ],
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "channels.policies.update": {
    "input": {
      "enabled": false,
      "requireMention": false,
      "allowDirectMessages": false,
      "allowGroupMessages": false,
      "allowThreadMessages": false,
      "dmPolicy": "sample",
      "groupPolicy": "sample",
      "allowTextCommandsWithoutMention": false,
      "allowlistUserIds": [
        "sample"
      ],
      "allowlistChannelIds": [
        "sample"
      ],
      "allowlistGroupIds": [
        "sample"
      ],
      "allowedCommands": [
        "sample"
      ],
      "groupPolicies": [
        {
          "id": "sample",
          "label": "sample",
          "groupId": "sample",
          "channelId": "sample",
          "workspaceId": "sample",
          "requireMention": false,
          "allowGroupMessages": false,
          "allowThreadMessages": false,
          "allowTextCommandsWithoutMention": false,
          "allowlistUserIds": [
            "sample"
          ],
          "allowlistChannelIds": [
            "sample"
          ],
          "allowlistGroupIds": [
            "sample"
          ],
          "allowedCommands": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "enabled": false,
      "requireMention": false,
      "allowDirectMessages": false,
      "allowGroupMessages": false,
      "allowThreadMessages": false,
      "dmPolicy": "sample",
      "groupPolicy": "sample",
      "allowTextCommandsWithoutMention": false,
      "allowlistUserIds": [
        "sample"
      ],
      "allowlistChannelIds": [
        "sample"
      ],
      "allowlistGroupIds": [
        "sample"
      ],
      "allowedCommands": [
        "sample"
      ],
      "groupPolicies": [
        {
          "id": "sample",
          "label": "sample",
          "groupId": "sample",
          "channelId": "sample",
          "workspaceId": "sample",
          "requireMention": false,
          "allowGroupMessages": false,
          "allowThreadMessages": false,
          "allowTextCommandsWithoutMention": false,
          "allowlistUserIds": [
            "sample"
          ],
          "allowlistChannelIds": [
            "sample"
          ],
          "allowlistGroupIds": [
            "sample"
          ],
          "allowedCommands": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "updatedAt": 0,
      "metadata": {}
    }
  },
  "channels.profiles.delete": {
    "input": {
      "surfaceKind": "sample",
      "channelId": "sample"
    },
    "output": {
      "surfaceKind": "sample",
      "channelId": "sample",
      "deleted": false
    }
  },
  "channels.profiles.get": {
    "input": {
      "surfaceKind": "sample",
      "channelId": "sample"
    },
    "output": {
      "binding": {
        "id": "sample",
        "surfaceKind": "sample",
        "channelId": "sample",
        "model": "sample",
        "provider": "sample",
        "permissionMode": "plan",
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "channels.profiles.list": {
    "input": {},
    "output": {
      "bindings": [
        {
          "id": "sample",
          "surfaceKind": "sample",
          "channelId": "sample",
          "model": "sample",
          "provider": "sample",
          "permissionMode": "plan",
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "channels.profiles.set": {
    "input": {
      "surfaceKind": "sample",
      "channelId": "sample",
      "model": "sample",
      "provider": "sample",
      "permissionMode": "plan",
      "metadata": {}
    },
    "output": {
      "binding": {
        "id": "sample",
        "surfaceKind": "sample",
        "channelId": "sample",
        "model": "sample",
        "provider": "sample",
        "permissionMode": "plan",
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "channels.repairs.list": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "actions": [
        {
          "id": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.routing.assign": {
    "input": {
      "channelId": "sample",
      "surfaceKind": "sample",
      "routeId": "sample",
      "profileId": "sample",
      "label": "sample"
    },
    "output": {
      "assignmentId": "sample",
      "channelId": "sample",
      "surfaceKind": "sample",
      "routeId": "sample",
      "profileId": "sample",
      "label": "sample",
      "createdAt": "sample",
      "updatedAt": "sample"
    }
  },
  "channels.routing.delete": {
    "input": {
      "assignmentId": "sample"
    },
    "output": {
      "deleted": false,
      "assignmentId": "sample"
    }
  },
  "channels.routing.list": {
    "input": {
      "profileId": "sample",
      "surfaceKind": "sample",
      "limit": 0
    },
    "output": {
      "routes": [
        {
          "id": "sample",
          "createdAt": "sample",
          "updatedAt": "sample",
          "surfaceKind": "sample",
          "routeId": "sample",
          "profileId": "sample",
          "label": "sample"
        }
      ],
      "total": 0
    }
  },
  "channels.setup.get": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "surface": "sample",
      "version": 0,
      "label": "sample",
      "setupMode": "sample",
      "description": "sample",
      "fields": [
        {
          "id": "sample",
          "label": "sample",
          "kind": "sample",
          "required": false,
          "detail": "sample",
          "placeholder": "sample",
          "configKey": "sample",
          "secretTargetId": "sample",
          "defaultValue": "sample",
          "options": [
            {
              "value": "sample",
              "label": "sample"
            }
          ],
          "metadata": {}
        }
      ],
      "secretTargets": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "required": false,
          "supports": [
            "sample"
          ],
          "serviceName": "sample",
          "serviceField": "sample",
          "envKeys": [
            "sample"
          ],
          "configKeys": [
            "sample"
          ],
          "detail": "sample",
          "metadata": {}
        }
      ],
      "externalSteps": [
        "sample"
      ],
      "metadata": {}
    }
  },
  "channels.status": {
    "input": {},
    "output": {
      "channels": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "state": "sample",
          "enabled": false,
          "accountId": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.targets.resolve": {
    "input": {
      "target": "sample",
      "input": "sample",
      "query": "sample",
      "accountId": "sample",
      "preferredKind": "sample",
      "threadId": "sample",
      "sessionId": "sample",
      "createIfMissing": false,
      "live": false,
      "metadata": {}
    },
    "output": {
      "surface": "sample",
      "target": {
        "surface": "sample",
        "input": "sample",
        "normalized": "sample",
        "kind": "sample",
        "to": "sample",
        "display": "sample",
        "accountId": "sample",
        "workspaceId": "sample",
        "channelId": "sample",
        "groupId": "sample",
        "threadId": "sample",
        "parentId": "sample",
        "sessionId": "sample",
        "sessionTarget": "sample",
        "bindingId": "sample",
        "directoryEntryId": "sample",
        "source": "sample",
        "metadata": {}
      }
    }
  },
  "channels.test.send": {
    "input": {
      "surface": "sample",
      "address": "sample",
      "body": "sample"
    },
    "output": {
      "surface": "sample",
      "delivered": false,
      "responseId": "sample",
      "address": "sample",
      "error": "sample"
    }
  },
  "channels.tools.invoke": {
    "input": {
      "accountId": "sample",
      "metadata": {}
    },
    "output": {
      "toolId": "sample",
      "surface": "sample",
      "result": {}
    }
  },
  "channels.tools.list": {
    "input": {},
    "output": {
      "tools": [
        {
          "id": "sample",
          "surface": "sample",
          "name": "sample",
          "description": "sample",
          "actionIds": [
            "sample"
          ],
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.tools.surface.list": {
    "input": {
      "surface": "sample"
    },
    "output": {
      "tools": [
        {
          "id": "sample",
          "surface": "sample",
          "name": "sample",
          "description": "sample",
          "actionIds": [
            "sample"
          ],
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "checkin.config.get": {
    "input": {},
    "output": {
      "config": {
        "enabled": false,
        "cadence": "sample",
        "deliveryChannel": "sample",
        "quietHours": "sample"
      }
    }
  },
  "checkin.config.set": {
    "input": {
      "enabled": false,
      "cadence": "sample",
      "deliveryChannel": "sample",
      "quietHours": "sample"
    },
    "output": {
      "config": {
        "enabled": false,
        "cadence": "sample",
        "deliveryChannel": "sample",
        "quietHours": "sample"
      }
    }
  },
  "checkin.receipts.list": {
    "input": {
      "limit": 0
    },
    "output": {
      "receipts": [
        {
          "id": "sample",
          "ranAt": 0,
          "trigger": "scheduled",
          "outcome": "delivered",
          "briefingSummary": "sample",
          "decisionReason": "sample",
          "deliveredMessage": "sample",
          "deliveryChannel": "sample",
          "deliveryId": "sample",
          "error": "sample"
        }
      ]
    }
  },
  "checkin.run": {
    "input": {},
    "output": {
      "outcome": "delivered",
      "summary": "sample",
      "deliveryId": "sample"
    }
  },
  "checkpoints.create": {
    "input": {
      "kind": "turn",
      "label": "sample",
      "retentionClass": "short",
      "turnId": "sample",
      "agentId": "sample",
      "sessionId": "sample",
      "paths": [
        "sample"
      ]
    },
    "output": {
      "checkpoint": {
        "id": "sample",
        "kind": "turn",
        "label": "sample",
        "createdAt": 0,
        "parentId": "sample",
        "turnId": "sample",
        "agentId": "sample",
        "sessionId": "sample",
        "retentionClass": "short",
        "commit": "sample",
        "sizeBytes": 0
      },
      "noop": false
    }
  },
  "checkpoints.diff": {
    "input": {
      "a": "sample",
      "b": "sample"
    },
    "output": {
      "diff": {
        "from": "sample",
        "to": "sample",
        "files": [
          "sample"
        ],
        "unifiedDiff": "sample",
        "stat": "sample"
      }
    }
  },
  "checkpoints.list": {
    "input": {
      "kind": "turn",
      "sessionId": "sample",
      "since": 0,
      "limit": 0
    },
    "output": {
      "checkpoints": [
        {
          "id": "sample",
          "kind": "turn",
          "label": "sample",
          "createdAt": 0,
          "parentId": "sample",
          "turnId": "sample",
          "agentId": "sample",
          "sessionId": "sample",
          "retentionClass": "short",
          "commit": "sample",
          "sizeBytes": 0
        }
      ]
    }
  },
  "checkpoints.restore": {
    "input": {
      "id": "sample",
      "paths": [
        "sample"
      ],
      "safetyCheckpoint": false,
      "confirm": false,
      "confirmToken": "sample"
    },
    "output": {
      "result": {
        "checkpointId": "sample",
        "safetyCheckpointId": "sample",
        "restoredFiles": [
          "sample"
        ],
        "removedFiles": [
          "sample"
        ]
      },
      "refused": false,
      "refusal": {
        "reason": "sample",
        "confirmField": "sample",
        "previewMethod": "sample",
        "options": [
          "sample"
        ]
      }
    }
  },
  "checkpoints.restorePreview": {
    "input": {
      "id": "sample",
      "paths": [
        "sample"
      ]
    },
    "output": {
      "token": "sample",
      "expiresAt": 0,
      "preview": {
        "checkpointId": "sample",
        "label": "sample",
        "affectedPathCount": 0,
        "affectedPathSample": [
          "sample"
        ],
        "stat": "sample"
      }
    }
  },
  "checkpoints.revertHunk": {
    "input": {
      "path": "sample",
      "hunk": "sample",
      "sessionId": "sample",
      "confirm": false,
      "confirmToken": "sample"
    },
    "output": {
      "receipt": {
        "reverted": false,
        "path": "sample",
        "hunkHeader": "sample",
        "addedLinesRemoved": 0,
        "removedLinesRestored": 0,
        "safetyCheckpointId": "sample",
        "undo": {
          "restoreCheckpointId": "sample"
        }
      },
      "refused": false,
      "refusal": {
        "reason": "sample",
        "confirmField": "sample",
        "previewMethod": "sample",
        "options": [
          "sample"
        ]
      }
    }
  },
  "checkpoints.revertHunkPreview": {
    "input": {
      "path": "sample",
      "hunk": "sample",
      "sessionId": "sample"
    },
    "output": {
      "path": "sample",
      "applies": false,
      "conflict": "sample",
      "hunkHeader": "sample",
      "addedLinesRemoved": 0,
      "removedLinesRestored": 0,
      "matchedAtLine": 0,
      "token": "sample",
      "expiresAt": 0
    }
  },
  "ci.status": {
    "input": {
      "repo": "sample",
      "ref": "sample",
      "prNumber": 0
    },
    "output": {
      "report": {
        "repo": "sample",
        "ref": "sample",
        "prNumber": 0,
        "overall": "passed",
        "jobs": [
          {
            "name": "sample",
            "status": "queued",
            "conclusion": "sample",
            "continueOnError": false,
            "url": "sample"
          }
        ],
        "violations": [
          "sample"
        ],
        "checkedAt": 0
      }
    }
  },
  "ci.watches.create": {
    "input": {
      "repo": "sample",
      "ref": "sample",
      "prNumber": 0,
      "deliveryChannel": "sample",
      "triggerFixSession": false
    },
    "output": {
      "watch": {
        "id": "sample",
        "repo": "sample",
        "ref": "sample",
        "prNumber": 0,
        "deliveryChannel": "sample",
        "triggerFixSession": false,
        "lastOverall": "passed",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "ci.watches.delete": {
    "input": {
      "watchId": "sample"
    },
    "output": {
      "watchId": "sample",
      "deleted": false
    }
  },
  "ci.watches.list": {
    "input": {},
    "output": {
      "watches": [
        {
          "id": "sample",
          "repo": "sample",
          "ref": "sample",
          "prNumber": 0,
          "deliveryChannel": "sample",
          "triggerFixSession": false,
          "lastOverall": "passed",
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "ci.watches.run": {
    "input": {
      "watchId": "sample"
    },
    "output": {
      "report": {
        "repo": "sample",
        "ref": "sample",
        "prNumber": 0,
        "overall": "passed",
        "jobs": [
          {
            "name": "sample",
            "status": "queued",
            "conclusion": "sample",
            "continueOnError": false,
            "url": "sample"
          }
        ],
        "violations": [
          "sample"
        ],
        "checkedAt": 0
      },
      "notified": false,
      "notificationId": "sample",
      "fixSessionTriggered": false,
      "fixSessionId": "sample",
      "fixSessionError": "sample",
      "fixSessionOffered": false,
      "retired": false
    }
  },
  "companion.chat.events.stream": {
    "input": {
      "sessionId": "sample"
    },
    "output": {}
  },
  "companion.chat.messages.create": {
    "input": {
      "body": "sample",
      "content": "sample",
      "attachments": [
        {
          "artifactId": "sample",
          "label": "sample",
          "metadata": {}
        }
      ],
      "metadata": {}
    },
    "output": {
      "messageId": "sample"
    }
  },
  "companion.chat.messages.edit": {
    "input": {
      "messageId": "sample",
      "body": "sample",
      "content": "sample",
      "attachments": [
        {
          "artifactId": "sample",
          "label": "sample",
          "metadata": {}
        }
      ],
      "metadata": {}
    },
    "output": {
      "sessionId": "sample",
      "editedFrom": "sample",
      "messageId": "sample",
      "supersededMessageIds": [
        "sample"
      ],
      "turnStarted": false
    }
  },
  "companion.chat.messages.list": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "content": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "createdAt": 0,
          "deliveryState": "cancelled",
          "inReplyTo": "sample"
        }
      ]
    }
  },
  "companion.chat.messages.retry": {
    "input": {
      "messageId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "regeneratedFrom": "sample",
      "supersededMessageIds": [
        "sample"
      ],
      "turnStarted": false
    }
  },
  "companion.chat.messages.steer": {
    "input": {
      "sessionId": "sample",
      "body": "sample",
      "content": "sample",
      "attachments": [
        {
          "artifactId": "sample",
          "label": "sample",
          "metadata": {}
        }
      ],
      "metadata": {}
    },
    "output": {
      "sessionId": "sample",
      "messageId": "sample",
      "steered": false,
      "cancelledTurnId": "sample",
      "turnStarted": false
    }
  },
  "companion.chat.sessions.close": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "status": "sample"
    }
  },
  "companion.chat.sessions.create": {
    "input": {
      "title": "sample",
      "model": "sample",
      "provider": "sample",
      "systemPrompt": "sample"
    },
    "output": {
      "sessionId": "sample",
      "createdAt": 0,
      "session": {
        "id": "sample",
        "kind": "companion-chat",
        "title": "sample",
        "model": "sample",
        "provider": "sample",
        "systemPrompt": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "closedAt": 0,
        "messageCount": 0
      }
    }
  },
  "companion.chat.sessions.delete": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "deleted": false
    }
  },
  "companion.chat.sessions.get": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "companion-chat",
        "title": "sample",
        "model": "sample",
        "provider": "sample",
        "systemPrompt": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "closedAt": 0,
        "messageCount": 0
      },
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "content": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "createdAt": 0,
          "deliveryState": "cancelled",
          "inReplyTo": "sample"
        }
      ]
    }
  },
  "companion.chat.sessions.list": {
    "input": {
      "includeClosed": false,
      "limit": 0
    },
    "output": {
      "sessions": [
        {
          "id": "sample",
          "kind": "companion-chat",
          "title": "sample",
          "model": "sample",
          "provider": "sample",
          "systemPrompt": "sample",
          "status": "active",
          "createdAt": 0,
          "updatedAt": 0,
          "closedAt": 0,
          "messageCount": 0
        }
      ],
      "totals": {
        "sessions": 0,
        "active": 0,
        "closed": 0
      }
    }
  },
  "companion.chat.sessions.update": {
    "input": {
      "title": "sample",
      "model": "sample",
      "provider": "sample",
      "systemPrompt": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "companion-chat",
        "title": "sample",
        "model": "sample",
        "provider": "sample",
        "systemPrompt": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "closedAt": 0,
        "messageCount": 0
      }
    }
  },
  "companion.chat.turns.cancel": {
    "input": {
      "sessionId": "sample",
      "turnId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "turnId": "sample",
      "cancelled": false,
      "alreadyCancelled": false,
      "partialPersisted": false
    }
  },
  "config.get": {
    "input": {},
    "output": {
      "danger": {},
      "controlPlane": {},
      "web": {},
      "network": {},
      "service": {},
      "providers": {},
      "ui": {},
      "channels": {},
      "watchers": {},
      "memory": {}
    }
  },
  "config.set": {
    "input": {
      "key": "sample"
    },
    "output": {
      "success": false,
      "key": "sample",
      "value": "sample"
    }
  },
  "credentials.get": {
    "input": {
      "key": "sample"
    },
    "output": {
      "available": false,
      "credentials": [
        {
          "key": "sample",
          "configured": false,
          "usable": false,
          "source": "sample",
          "scope": "sample",
          "secure": false,
          "overriddenByEnv": false,
          "refSource": "sample"
        }
      ]
    }
  },
  "continuity.snapshot": {
    "input": {},
    "output": {
      "sessionId": "sample",
      "status": "sample",
      "recoveryState": "sample",
      "lastSessionPointer": "sample",
      "recoveryFilePresent": false,
      "recoveryFile": {
        "title": "sample",
        "timestamp": 0,
        "sessionId": "sample",
        "returnContext": {
          "activityLabel": "sample",
          "statusLabel": "sample",
          "lastUserPrompt": "sample",
          "lastAssistantReply": "sample",
          "pendingApprovals": 0,
          "toolCallCount": 0,
          "toolResultCount": 0,
          "assistantTurnCount": 0,
          "userTurnCount": 0,
          "lastRole": "sample",
          "activeTasks": 0,
          "blockedTasks": 0,
          "remoteContracts": 0,
          "remoteRunners": [
            "sample"
          ],
          "worktreeCount": 0,
          "worktreePaths": [
            "sample"
          ],
          "openPanels": [
            "sample"
          ],
          "lines": [
            "sample"
          ],
          "assistedNarrative": "sample"
        }
      }
    }
  },
  "control.auth.current": {
    "input": {},
    "output": {
      "authenticated": false,
      "authMode": "anonymous",
      "tokenPresent": false,
      "authorizationHeaderPresent": false,
      "sessionCookiePresent": false,
      "principalId": "sample",
      "principalKind": "user",
      "admin": false,
      "scopes": [
        "sample"
      ],
      "roles": [
        "sample"
      ]
    }
  },
  "control.auth.login": {
    "input": {
      "username": "sample",
      "password": "sample"
    },
    "output": {
      "authenticated": false,
      "token": "sample",
      "username": "sample",
      "expiresAt": 0
    }
  },
  "control.clients.list": {
    "input": {},
    "output": {
      "clients": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "connectedAt": 0,
          "lastSeenAt": 0,
          "userId": "sample"
        }
      ]
    }
  },
  "control.contract": {
    "input": {},
    "output": {
      "contract": {
        "version": 0,
        "product": {
          "id": "sample",
          "surface": "sample",
          "version": "sample"
        },
        "auth": {
          "modes": [
            "sample"
          ],
          "login": {
            "method": "sample",
            "path": "sample",
            "requestSchema": {
              "username": "sample",
              "password": "sample"
            },
            "responseSchema": {
              "authenticated": false,
              "token": "sample",
              "username": "sample",
              "expiresAt": 0
            }
          },
          "current": {
            "method": "sample",
            "path": "sample",
            "aliasPaths": [
              "sample"
            ],
            "responseSchema": {
              "authenticated": false,
              "authMode": "anonymous",
              "tokenPresent": false,
              "authorizationHeaderPresent": false,
              "sessionCookiePresent": false,
              "principalId": "sample",
              "principalKind": "user",
              "admin": false,
              "scopes": [
                "sample"
              ],
              "roles": [
                "sample"
              ]
            }
          },
          "sessionCookie": {
            "name": "sample",
            "httpOnly": false,
            "sameSite": "sample",
            "path": "sample"
          },
          "bearer": {
            "header": "sample",
            "queryParameters": [
              "sample"
            ]
          }
        },
        "transports": {
          "http": {
            "statusPath": "sample",
            "methodsPath": "sample",
            "eventsCatalogPath": "sample"
          },
          "sse": {
            "path": "sample",
            "query": {
              "domains": "sample"
            }
          },
          "websocket": {
            "path": "sample",
            "clientFrames": [
              {
                "type": "sample",
                "fields": [
                  "sample"
                ]
              }
            ],
            "serverFrames": [
              {
                "type": "sample",
                "fields": [
                  "sample"
                ]
              }
            ]
          }
        },
        "operator": {
          "methods": [
            {
              "id": "sample",
              "title": "sample",
              "description": "sample",
              "category": "sample",
              "source": "sample",
              "access": "sample",
              "transport": [
                "sample"
              ],
              "scopes": [
                "sample"
              ],
              "http": {
                "method": "sample",
                "path": "sample"
              },
              "events": [
                "sample"
              ],
              "inputSchema": {},
              "outputSchema": {},
              "pluginId": "sample",
              "dangerous": false,
              "invokable": false,
              "metadata": {}
            }
          ],
          "events": [
            {
              "id": "sample",
              "title": "sample",
              "description": "sample",
              "category": "sample",
              "source": "sample",
              "transport": [
                "sample"
              ],
              "scopes": [
                "sample"
              ],
              "domains": [
                "sample"
              ],
              "wireEvents": [
                "sample"
              ],
              "outputSchema": {},
              "pluginId": "sample",
              "metadata": {}
            }
          ],
          "schemaCoverage": {
            "methods": 0,
            "typedInputs": 0,
            "genericInputs": 0,
            "typedOutputs": 0,
            "genericOutputs": 0
          },
          "eventCoverage": {
            "events": 0,
            "withDomains": 0,
            "withWireEvents": 0
          },
          "validationCoverage": {
            "methods": 0,
            "validated": 0,
            "skippedGeneric": 0,
            "skippedUntyped": 0
          }
        },
        "peer": {
          "contractPath": "sample",
          "relationship": "sample"
        }
      }
    }
  },
  "control.events.catalog": {
    "input": {
      "category": "sample",
      "domain": "sample"
    },
    "output": {
      "events": [
        {
          "id": "sample",
          "title": "sample",
          "description": "sample",
          "category": "sample",
          "source": "sample",
          "transport": [
            "sample"
          ],
          "scopes": [
            "sample"
          ],
          "domains": [
            "sample"
          ],
          "wireEvents": [
            "sample"
          ],
          "outputSchema": {},
          "pluginId": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "control.events.stream": {
    "input": {
      "domains": "sample"
    },
    "output": {
      "contentType": "sample",
      "mode": "sample"
    }
  },
  "control.messages.list": {
    "input": {},
    "output": {
      "messages": [
        {
          "id": "sample",
          "surface": "sample",
          "createdAt": 0,
          "title": "sample",
          "body": "sample",
          "level": "info",
          "routeId": "sample",
          "surfaceId": "sample",
          "clientId": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "contentPath": "sample",
              "contentUrl": "sample",
              "dataBase64": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "control.methods.get": {
    "input": {
      "methodId": "sample"
    },
    "output": {
      "method": {
        "id": "sample",
        "title": "sample",
        "description": "sample",
        "category": "sample",
        "source": "sample",
        "access": "sample",
        "transport": [
          "sample"
        ],
        "scopes": [
          "sample"
        ],
        "http": {
          "method": "sample",
          "path": "sample"
        },
        "events": [
          "sample"
        ],
        "inputSchema": {},
        "outputSchema": {},
        "pluginId": "sample",
        "dangerous": false,
        "invokable": false,
        "metadata": {}
      }
    }
  },
  "control.methods.list": {
    "input": {
      "category": "sample",
      "source": "sample"
    },
    "output": {
      "methods": [
        {
          "id": "sample",
          "title": "sample",
          "description": "sample",
          "category": "sample",
          "source": "sample",
          "access": "sample",
          "transport": [
            "sample"
          ],
          "scopes": [
            "sample"
          ],
          "http": {
            "method": "sample",
            "path": "sample"
          },
          "events": [
            "sample"
          ],
          "inputSchema": {},
          "outputSchema": {},
          "pluginId": "sample",
          "dangerous": false,
          "invokable": false,
          "metadata": {}
        }
      ]
    }
  },
  "control.snapshot": {
    "input": {},
    "output": {
      "server": {
        "enabled": false,
        "host": "sample",
        "port": 0,
        "baseUrl": "sample",
        "streamingMode": "sse",
        "sessionTtlMs": 0
      },
      "totals": {
        "clients": 0,
        "activeClients": 0,
        "surfaceMessages": 0,
        "recentEvents": 0,
        "requests": 0,
        "errors": 0
      },
      "clients": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "connectedAt": 0,
          "lastSeenAt": 0,
          "userId": "sample"
        }
      ],
      "messages": [
        {
          "id": "sample",
          "surface": "sample",
          "createdAt": 0,
          "title": "sample",
          "body": "sample",
          "level": "info",
          "routeId": "sample",
          "surfaceId": "sample",
          "clientId": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "contentPath": "sample",
              "contentUrl": "sample",
              "dataBase64": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "metadata": {}
        }
      ],
      "recentEvents": [
        {
          "id": "sample",
          "event": "sample",
          "createdAt": 0,
          "payload": "sample"
        }
      ]
    }
  },
  "control.status": {
    "input": {
      "receipts": "consume"
    },
    "output": {
      "status": "sample",
      "version": "sample",
      "receipts": [
        {
          "id": "sample",
          "text": "sample",
          "at": 0
        }
      ]
    }
  },
  "control.web": {
    "input": {},
    "output": {
      "html": "sample"
    }
  },
  "cost.attribution.get": {
    "input": {
      "window": "24h",
      "dimension": "agent"
    },
    "output": {
      "window": "24h",
      "windowStartMs": 0,
      "dimension": "agent",
      "totalCostUsd": 0,
      "costState": "priced",
      "costSource": "user",
      "pricingAsOf": "sample",
      "pricedRecordCount": 0,
      "unpricedRecordCount": 0,
      "tokens": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "rows": [
        {
          "key": "sample",
          "costUsd": 0,
          "costState": "priced",
          "costSource": "user",
          "pricingAsOf": "sample",
          "pricedRecordCount": 0,
          "unpricedRecordCount": 0,
          "tokens": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0
          }
        }
      ]
    }
  },
  "deliveries.get": {
    "input": {
      "deliveryId": "sample"
    },
    "output": {
      "delivery": {
        "id": "sample",
        "runId": "sample",
        "jobId": "sample",
        "target": {
          "kind": "none",
          "surfaceKind": "tui",
          "address": "sample",
          "routeId": "sample",
          "label": "sample"
        },
        "status": "pending",
        "startedAt": 0,
        "endedAt": 0,
        "error": "sample",
        "responseId": "sample"
      }
    }
  },
  "deliveries.list": {
    "input": {},
    "output": {
      "totals": {
        "queued": 0,
        "started": 0,
        "succeeded": 0,
        "failed": 0,
        "deadLettered": 0
      },
      "attempts": [
        {
          "id": "sample",
          "runId": "sample",
          "jobId": "sample",
          "target": {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          },
          "status": "pending",
          "startedAt": 0,
          "endedAt": 0,
          "error": "sample",
          "responseId": "sample"
        }
      ]
    }
  },
  "email.draft.create": {
    "input": {
      "to": "sample",
      "subject": "sample",
      "body": "sample",
      "inReplyTo": "sample",
      "references": "sample"
    },
    "output": {
      "uid": 0,
      "draftId": "sample"
    }
  },
  "email.inbox.list": {
    "input": {
      "limit": 0,
      "since": "sample",
      "unreadOnly": false
    },
    "output": {
      "messages": [
        {
          "uid": 0,
          "from": "sample",
          "subject": "sample",
          "date": "sample",
          "unread": false,
          "bodyPreview": "sample",
          "messageId": "sample"
        }
      ],
      "total": 0
    }
  },
  "email.inbox.read": {
    "input": {
      "uid": 0
    },
    "output": {
      "uid": 0,
      "from": "sample",
      "subject": "sample",
      "date": "sample",
      "messageId": "sample",
      "bodyText": "sample",
      "bodyHtml": "sample",
      "attachments": [
        {
          "filename": "sample",
          "contentType": "sample",
          "sizeBytes": 0
        }
      ]
    }
  },
  "email.send": {
    "input": {
      "to": "sample",
      "subject": "sample",
      "body": "sample",
      "inReplyTo": "sample",
      "confirm": false
    },
    "output": {
      "messageId": "sample",
      "sentAt": "sample"
    }
  },
  "flags.graduation.report": {
    "input": {},
    "output": {
      "generatedAt": 0,
      "entries": [
        {
          "flagId": "sample",
          "name": "sample",
          "tier": 0,
          "currentDefault": "enabled",
          "runtimeToggleable": false,
          "state": "dark",
          "evidence": {
            "instrumentation": "divergence-simulation",
            "divergence": {
              "divergenceRate": 0,
              "totalEvaluations": 0,
              "gateStatus": "allowed"
            },
            "note": "sample"
          },
          "blocker": {
            "reason": "sample",
            "date": "sample"
          },
          "note": "sample"
        }
      ],
      "summary": {
        "total": 0,
        "dark": 0,
        "soaking": 0,
        "graduateCandidate": 0,
        "graduated": 0,
        "blocked": 0
      },
      "releaseBlockers": [
        "sample"
      ]
    }
  },
  "fleet.archive": {
    "input": {
      "id": "sample"
    },
    "output": {
      "archived": false,
      "count": 0,
      "reason": "sample"
    }
  },
  "fleet.archived.list": {
    "input": {},
    "output": {
      "capturedAt": 0,
      "nodes": [
        {
          "id": "sample",
          "kind": "agent",
          "parentId": "sample",
          "label": "sample",
          "task": "sample",
          "state": "thinking",
          "startedAt": 0,
          "completedAt": 0,
          "elapsedMs": 0,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "llmCallCount": 0,
            "turnCount": 0,
            "toolCallCount": 0
          },
          "model": "sample",
          "provider": "sample",
          "costUsd": 0,
          "costState": "priced",
          "costSource": "user",
          "pricingAsOf": "sample",
          "currentActivity": {
            "kind": "tool",
            "text": "sample",
            "toolName": "sample",
            "at": 0
          },
          "capabilities": {
            "interruptible": false,
            "killable": false,
            "pausable": false,
            "resumable": false,
            "steerable": false
          },
          "needsAttention": {
            "reason": "approval",
            "detail": "sample"
          },
          "sessionRef": {
            "sessionId": "sample",
            "agentId": "sample"
          }
        }
      ]
    }
  },
  "fleet.archiveFinished": {
    "input": {},
    "output": {
      "archivedCount": 0
    }
  },
  "fleet.attempts.judge": {
    "input": {
      "groupId": "sample"
    },
    "output": {
      "proposedWinnerItemId": "sample",
      "reasons": [
        "sample"
      ],
      "model": "sample",
      "scoredBy": "model"
    }
  },
  "fleet.attempts.list": {
    "input": {
      "workstreamId": "sample"
    },
    "output": {
      "groups": [
        {
          "groupId": "sample",
          "workstreamId": "sample",
          "sourceTitle": "sample",
          "ready": false,
          "candidates": [
            {
              "itemId": "sample",
              "attemptIndex": 0,
              "state": "held-merge",
              "title": "sample",
              "worktreePath": "sample",
              "branch": "sample",
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "llmCallCount": 0,
                "turnCount": 0,
                "toolCallCount": 0,
                "costUsd": 0,
                "costState": "priced",
                "costSource": "user",
                "pricingAsOf": "sample"
              },
              "failureReason": "sample",
              "diff": {
                "files": [
                  "sample"
                ],
                "unifiedDiff": "sample",
                "stat": "sample"
              }
            }
          ],
          "autoAccept": false,
          "judgment": {
            "proposedWinnerItemId": "sample",
            "reasons": [
              "sample"
            ],
            "model": "sample",
            "scoredBy": "model"
          }
        }
      ]
    }
  },
  "fleet.attempts.pick": {
    "input": {
      "groupId": "sample",
      "winnerItemId": "sample",
      "confirm": false
    },
    "output": {
      "applied": false,
      "groupId": "sample",
      "winnerItemId": "sample",
      "loserItemIds": [
        "sample"
      ],
      "auto": false,
      "requiresConfirm": false,
      "group": {
        "groupId": "sample",
        "workstreamId": "sample",
        "sourceTitle": "sample",
        "ready": false,
        "candidates": [
          {
            "itemId": "sample",
            "attemptIndex": 0,
            "state": "held-merge",
            "title": "sample",
            "worktreePath": "sample",
            "branch": "sample",
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0,
              "llmCallCount": 0,
              "turnCount": 0,
              "toolCallCount": 0,
              "costUsd": 0,
              "costState": "priced",
              "costSource": "user",
              "pricingAsOf": "sample"
            },
            "failureReason": "sample",
            "diff": {
              "files": [
                "sample"
              ],
              "unifiedDiff": "sample",
              "stat": "sample"
            }
          }
        ],
        "autoAccept": false,
        "judgment": {
          "proposedWinnerItemId": "sample",
          "reasons": [
            "sample"
          ],
          "model": "sample",
          "scoredBy": "model"
        }
      }
    }
  },
  "fleet.conflicts.list": {
    "input": {
      "workstreamId": "sample"
    },
    "output": {
      "conflicts": [
        {
          "workstreamId": "sample",
          "itemId": "sample",
          "title": "sample",
          "worktreePath": "sample",
          "branch": "sample",
          "files": [
            "sample"
          ],
          "resolutionSessionId": "sample"
        }
      ]
    }
  },
  "fleet.conflicts.resolve": {
    "input": {
      "itemId": "sample"
    },
    "output": {
      "itemId": "sample",
      "sessionId": "sample",
      "worktreePath": "sample",
      "files": [
        "sample"
      ]
    }
  },
  "fleet.list": {
    "input": {
      "kinds": [
        "sample"
      ],
      "states": [
        "sample"
      ],
      "limit": 0,
      "cursor": "sample"
    },
    "output": {
      "items": [
        {
          "id": "sample",
          "kind": "agent",
          "parentId": "sample",
          "label": "sample",
          "task": "sample",
          "state": "thinking",
          "startedAt": 0,
          "completedAt": 0,
          "elapsedMs": 0,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "llmCallCount": 0,
            "turnCount": 0,
            "toolCallCount": 0
          },
          "model": "sample",
          "provider": "sample",
          "costUsd": 0,
          "costState": "priced",
          "costSource": "user",
          "pricingAsOf": "sample",
          "currentActivity": {
            "kind": "tool",
            "text": "sample",
            "toolName": "sample",
            "at": 0
          },
          "capabilities": {
            "interruptible": false,
            "killable": false,
            "pausable": false,
            "resumable": false,
            "steerable": false
          },
          "needsAttention": {
            "reason": "approval",
            "detail": "sample"
          },
          "sessionRef": {
            "sessionId": "sample",
            "agentId": "sample"
          }
        }
      ],
      "nextCursor": "sample",
      "hasMore": false,
      "capturedAt": 0
    }
  },
  "fleet.snapshot": {
    "input": {},
    "output": {
      "capturedAt": 0,
      "nodes": [
        {
          "id": "sample",
          "kind": "agent",
          "parentId": "sample",
          "label": "sample",
          "task": "sample",
          "state": "thinking",
          "startedAt": 0,
          "completedAt": 0,
          "elapsedMs": 0,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "llmCallCount": 0,
            "turnCount": 0,
            "toolCallCount": 0
          },
          "model": "sample",
          "provider": "sample",
          "costUsd": 0,
          "costState": "priced",
          "costSource": "user",
          "pricingAsOf": "sample",
          "currentActivity": {
            "kind": "tool",
            "text": "sample",
            "toolName": "sample",
            "at": 0
          },
          "capabilities": {
            "interruptible": false,
            "killable": false,
            "pausable": false,
            "resumable": false,
            "steerable": false
          },
          "needsAttention": {
            "reason": "approval",
            "detail": "sample"
          },
          "sessionRef": {
            "sessionId": "sample",
            "agentId": "sample"
          }
        }
      ],
      "truncated": false,
      "totalCount": 0
    }
  },
  "fleet.unarchive": {
    "input": {
      "id": "sample"
    },
    "output": {
      "restored": 0
    }
  },
  "health.snapshot": {
    "input": {},
    "output": {
      "overall": "healthy",
      "degradedDomains": [
        "sample"
      ],
      "providerProblems": [
        "sample"
      ],
      "mcpProblems": {
        "degraded": [
          "sample"
        ],
        "quarantined": [
          "sample"
        ]
      },
      "integrationProblems": [
        "sample"
      ],
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "intelligence.snapshot": {
    "input": {},
    "output": {
      "diagnosticsStatus": "sample",
      "symbolSearchStatus": "sample",
      "completionsStatus": "sample",
      "hoverStatus": "sample",
      "errorCount": 0,
      "warningCount": 0,
      "totalRequests": 0,
      "avgLatencyMs": 0
    }
  },
  "homeassistant.homeGraph.askHomeGraph": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "query": "sample",
      "limit": 0,
      "mode": "sample",
      "includeSources": false,
      "includeConfidence": false,
      "includeLinkedObjects": false,
      "timeoutMs": 0
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "query": "sample",
      "answer": {},
      "results": [
        "sample"
      ]
    }
  },
  "homeassistant.homeGraph.browse": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "nodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromKind": "sample",
          "fromId": "sample",
          "toKind": "sample",
          "toId": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.export": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample"
    },
    "output": {
      "version": 0,
      "exportedAt": 0,
      "spaceId": "sample",
      "installationId": "sample",
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "nodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromKind": "sample",
          "fromId": "sample",
          "toKind": "sample",
          "toId": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "extractions": [
        {
          "id": "sample",
          "sourceId": "sample",
          "artifactId": "sample",
          "extractorId": "sample",
          "format": "sample",
          "title": "sample",
          "summary": "sample",
          "excerpt": "sample",
          "sections": [
            "sample"
          ],
          "links": [
            "sample"
          ],
          "estimatedTokens": 0,
          "structure": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.generateHomeGraphPacket": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "packetKind": "sample",
      "title": "sample",
      "sharingProfile": "sample",
      "includeFields": [
        "sample"
      ],
      "excludeFields": [
        "sample"
      ],
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "markdown": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifact": {}
    }
  },
  "homeassistant.homeGraph.generateRoomPage": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "areaId": "sample",
      "roomId": "sample",
      "title": "sample",
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "markdown": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifact": {}
    }
  },
  "homeassistant.homeGraph.import": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "data": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "imported": {}
    }
  },
  "homeassistant.homeGraph.ingestHomeGraphArtifact": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "artifactId": "sample",
      "path": "sample",
      "uri": "sample",
      "title": "sample",
      "tags": [
        "sample"
      ],
      "target": {},
      "allowPrivateHosts": false,
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.ingestHomeGraphNote": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "title": "sample",
      "body": "sample",
      "category": "sample",
      "tags": [
        "sample"
      ],
      "target": {},
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.ingestHomeGraphUrl": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "url": "sample",
      "title": "sample",
      "tags": [
        "sample"
      ],
      "target": {},
      "allowPrivateHosts": false,
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.linkHomeGraphKnowledge": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "sourceId": "sample",
      "nodeId": "sample",
      "target": {},
      "relation": "sample",
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "edge": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "target": {}
    }
  },
  "homeassistant.homeGraph.listHomeGraphIssues": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "status": "sample",
      "severity": "sample",
      "code": "sample"
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.map": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "includeSources": false,
      "includeIssues": false,
      "includeGenerated": false,
      "query": "sample",
      "recordKinds": [
        "sample"
      ],
      "ids": [
        "sample"
      ],
      "linkedToIds": [
        "sample"
      ],
      "nodeKinds": [
        "sample"
      ],
      "sourceTypes": [
        "sample"
      ],
      "sourceStatuses": [
        "sample"
      ],
      "nodeStatuses": [
        "sample"
      ],
      "issueCodes": [
        "sample"
      ],
      "issueStatuses": [
        "sample"
      ],
      "issueSeverities": [
        "sample"
      ],
      "edgeRelations": [
        "sample"
      ],
      "tags": [
        "sample"
      ],
      "minConfidence": 0,
      "objectKinds": [
        "sample"
      ],
      "entityIds": [
        "sample"
      ],
      "deviceIds": [
        "sample"
      ],
      "areaIds": [
        "sample"
      ],
      "integrationIds": [
        "sample"
      ],
      "integrationDomains": [
        "sample"
      ],
      "domains": [
        "sample"
      ],
      "deviceClasses": [
        "sample"
      ],
      "labels": [
        "sample"
      ],
      "ha": {
        "objectKinds": [
          "sample"
        ],
        "entityIds": [
          "sample"
        ],
        "deviceIds": [
          "sample"
        ],
        "areaIds": [
          "sample"
        ],
        "integrationIds": [
          "sample"
        ],
        "integrationDomains": [
          "sample"
        ],
        "domains": [
          "sample"
        ],
        "deviceClasses": [
          "sample"
        ],
        "labels": [
          "sample"
        ]
      }
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "generatedAt": 0,
      "width": 0,
      "height": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "totalNodeCount": 0,
      "totalEdgeCount": 0,
      "facets": {
        "recordKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceTypes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueCodes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueSeverities": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "edgeRelations": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "tags": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "homeAssistant": {}
      },
      "nodes": [
        {
          "id": "sample",
          "recordKind": "sample",
          "kind": "sample",
          "title": "sample",
          "summary": "sample",
          "x": 0,
          "y": 0,
          "radius": 0,
          "metadata": {}
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromId": "sample",
          "toId": "sample",
          "source": "sample",
          "target": "sample",
          "fromTitle": "sample",
          "toTitle": "sample",
          "sourceTitle": "sample",
          "targetTitle": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {}
        }
      ],
      "svg": "sample"
    }
  },
  "homeassistant.homeGraph.pages.list": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "includeMarkdown": false
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "pages": [
        "sample"
      ]
    }
  },
  "homeassistant.homeGraph.refinement.run": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "gapIds": [
        "sample"
      ],
      "sourceIds": [
        "sample"
      ],
      "limit": 0,
      "maxRunMs": 0,
      "force": false
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "result": {
        "scannedGaps": 0,
        "candidateGaps": 0,
        "processedGaps": 0,
        "createdGaps": 0,
        "repairableGaps": 0,
        "suppressedGaps": 0,
        "skippedGaps": 0,
        "searched": 0,
        "ingestedSources": 0,
        "linkedRepairs": 0,
        "blockedGaps": 0,
        "closedGaps": 0,
        "queuedTasks": 0,
        "requestedLimit": 0,
        "effectiveLimit": 0,
        "coalesced": false,
        "truncated": false,
        "budgetExhausted": false,
        "taskIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "errors": [
          "sample"
        ]
      }
    }
  },
  "homeassistant.homeGraph.refinement.task.cancel": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "id": "sample"
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.refinement.task.get": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "id": "sample"
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.refinement.tasks.list": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "state": "sample",
      "subjectId": "sample",
      "gapId": "sample"
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "tasks": [
        {
          "id": "sample",
          "spaceId": "sample",
          "subjectKind": "sample",
          "subjectId": "sample",
          "subjectTitle": "sample",
          "subjectType": "sample",
          "gapId": "sample",
          "issueId": "sample",
          "state": "detected",
          "priority": "low",
          "trigger": "ingest",
          "budget": {},
          "attemptCount": 0,
          "blockedReason": "sample",
          "nextRepairAttemptAt": 0,
          "acceptedSourceIds": [
            "sample"
          ],
          "ingestedSourceIds": [
            "sample"
          ],
          "rejectedSourceUrls": [
            "sample"
          ],
          "promotedFactCount": 0,
          "sourceAssessments": [
            "sample"
          ],
          "trace": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.refreshDevicePassport": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "deviceId": "sample",
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "markdown": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifact": {}
    }
  },
  "homeassistant.homeGraph.reindex": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "maxRunMs": 0,
      "semanticLimit": 0,
      "semanticMaxRunMs": 0,
      "generatedPageLimit": 0,
      "force": false,
      "refreshPages": false
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "scanned": 0,
      "reparsed": 0,
      "skipped": 0,
      "failed": 0,
      "changedSourceCount": 0,
      "forcedSourceCount": 0,
      "skippedGeneratedPageArtifactCount": 0,
      "refreshedGeneratedPageCount": 0,
      "generatedPagePolicyVersion": "sample",
      "coalesced": false,
      "truncated": false,
      "budgetExhausted": false,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "failures": [
        "sample"
      ],
      "linked": [
        "sample"
      ],
      "semantic": {},
      "generated": {}
    }
  },
  "homeassistant.homeGraph.reset": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "dryRun": false,
      "preserveArtifacts": false
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "installationId": "sample",
      "dryRun": false,
      "deleted": {},
      "artifactDeleteCandidates": 0,
      "deletedArtifacts": 0,
      "preservedArtifacts": 0,
      "artifactsDeleted": false
    }
  },
  "homeassistant.homeGraph.reviewHomeGraphFact": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "issueId": "sample",
      "nodeId": "sample",
      "sourceId": "sample",
      "action": "sample",
      "value": {},
      "reviewer": "sample"
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "issue": {
        "id": "sample",
        "severity": "sample",
        "code": "sample",
        "message": "sample",
        "status": "sample",
        "sourceId": "sample",
        "nodeId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "node": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.sources.list": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.status": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample"
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "installationId": "sample",
      "sourceCount": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "issueCount": 0,
      "extractionCount": 0,
      "lastSnapshotAt": 0,
      "readiness": {},
      "capabilities": [
        "sample"
      ]
    }
  },
  "homeassistant.homeGraph.syncHomeGraph": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "homeId": "sample",
      "title": "sample",
      "capturedAt": 0,
      "entities": [
        "sample"
      ],
      "devices": [
        "sample"
      ],
      "areas": [
        "sample"
      ],
      "automations": [
        "sample"
      ],
      "scripts": [
        "sample"
      ],
      "scenes": [
        "sample"
      ],
      "labels": [
        "sample"
      ],
      "integrations": [
        "sample"
      ],
      "helpers": [
        "sample"
      ],
      "pageAutomation": {},
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "installationId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "home": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "created": {},
      "generated": {
        "devicePassports": 0,
        "roomPages": 0,
        "artifacts": 0,
        "sources": 0,
        "deferredDevicePassports": 0,
        "deferredRoomPages": 0,
        "truncated": false,
        "errors": [
          "sample"
        ]
      },
      "counts": {}
    }
  },
  "homeassistant.homeGraph.unlinkHomeGraphKnowledge": {
    "input": {
      "installationId": "sample",
      "knowledgeSpaceId": "sample",
      "sourceId": "sample",
      "nodeId": "sample",
      "target": {},
      "relation": "sample",
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "edge": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "target": {}
    }
  },
  "knowledge.ask": {
    "input": {
      "query": "sample",
      "knowledgeSpaceId": "sample",
      "limit": 0,
      "mode": "sample",
      "includeSources": false,
      "includeConfidence": false,
      "includeLinkedObjects": false,
      "candidateSourceIds": [
        "sample"
      ],
      "candidateNodeIds": [
        "sample"
      ],
      "strictCandidates": false,
      "timeoutMs": 0,
      "metadata": {}
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "query": "sample",
      "answer": {
        "text": "sample",
        "mode": "sample",
        "confidence": 0,
        "sources": [
          {
            "id": "sample",
            "connectorId": "sample",
            "sourceType": "url",
            "title": "sample",
            "sourceUri": "sample",
            "canonicalUri": "sample",
            "summary": "sample",
            "description": "sample",
            "tags": [
              "sample"
            ],
            "folderPath": "sample",
            "status": "sample",
            "artifactId": "sample",
            "contentHash": "sample",
            "lastCrawledAt": 0,
            "crawlError": "sample",
            "sessionId": "sample",
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "linkedObjects": [
          {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "facts": [
          {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "gaps": [
          {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "synthesized": false
      },
      "results": [
        {
          "kind": "sample",
          "id": "sample",
          "score": 0,
          "reason": "sample",
          "source": {
            "id": "sample",
            "connectorId": "sample",
            "sourceType": "url",
            "title": "sample",
            "sourceUri": "sample",
            "canonicalUri": "sample",
            "summary": "sample",
            "description": "sample",
            "tags": [
              "sample"
            ],
            "folderPath": "sample",
            "status": "sample",
            "artifactId": "sample",
            "contentHash": "sample",
            "lastCrawledAt": 0,
            "crawlError": "sample",
            "sessionId": "sample",
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          },
          "node": {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        }
      ]
    }
  },
  "knowledge.candidate.decide": {
    "input": {
      "decision": "accept",
      "decidedBy": "sample",
      "reason": "sample",
      "metadata": {}
    },
    "output": {
      "candidate": {
        "id": "sample",
        "candidateType": "sample",
        "status": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "title": "sample",
        "summary": "sample",
        "score": 0,
        "evidence": [
          "sample"
        ],
        "suggestedMemoryClass": "sample",
        "suggestedScope": "sample",
        "decidedAt": 0,
        "decidedBy": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.candidate.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "candidate": {
        "id": "sample",
        "candidateType": "sample",
        "status": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "title": "sample",
        "summary": "sample",
        "score": 0,
        "evidence": [
          "sample"
        ],
        "suggestedMemoryClass": "sample",
        "suggestedScope": "sample",
        "decidedAt": 0,
        "decidedBy": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.candidates.list": {
    "input": {
      "limit": 0,
      "status": "sample",
      "subjectKind": "sample",
      "subjectId": "sample"
    },
    "output": {
      "candidates": [
        {
          "id": "sample",
          "candidateType": "sample",
          "status": "sample",
          "subjectKind": "sample",
          "subjectId": "sample",
          "title": "sample",
          "summary": "sample",
          "score": 0,
          "evidence": [
            "sample"
          ],
          "suggestedMemoryClass": "sample",
          "suggestedScope": "sample",
          "decidedAt": 0,
          "decidedBy": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.connector.doctor": {
    "input": {
      "id": "sample"
    },
    "output": {
      "report": {
        "connectorId": "sample",
        "ready": false,
        "summary": "sample",
        "checks": [
          {
            "id": "sample",
            "label": "sample",
            "status": "pass",
            "detail": "sample",
            "metadata": {}
          }
        ],
        "hints": [
          "sample"
        ],
        "metadata": {}
      }
    }
  },
  "knowledge.connector.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "connector": {
        "id": "sample",
        "displayName": "sample",
        "version": "sample",
        "description": "sample",
        "sourceType": "url",
        "inputSchema": {},
        "examples": [
          "sample"
        ],
        "capabilities": [
          "sample"
        ],
        "setup": {
          "version": "sample",
          "summary": "sample",
          "transportHints": [
            "sample"
          ],
          "steps": [
            "sample"
          ],
          "fields": [
            {
              "key": "sample",
              "label": "sample",
              "kind": "text",
              "optional": false,
              "source": "inline",
              "description": "sample"
            }
          ],
          "metadata": {}
        },
        "metadata": {}
      }
    }
  },
  "knowledge.connectors.list": {
    "input": {},
    "output": {
      "connectors": [
        {
          "id": "sample",
          "displayName": "sample",
          "version": "sample",
          "description": "sample",
          "sourceType": "url",
          "inputSchema": {},
          "examples": [
            "sample"
          ],
          "capabilities": [
            "sample"
          ],
          "setup": {
            "version": "sample",
            "summary": "sample",
            "transportHints": [
              "sample"
            ],
            "steps": [
              "sample"
            ],
            "fields": [
              {
                "key": "sample",
                "label": "sample",
                "kind": "text",
                "optional": false,
                "source": "inline",
                "description": "sample"
              }
            ],
            "metadata": {}
          },
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.extraction.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.extractions.list": {
    "input": {
      "limit": 0,
      "sourceId": "sample",
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "extractions": [
        {
          "id": "sample",
          "sourceId": "sample",
          "artifactId": "sample",
          "extractorId": "sample",
          "format": "sample",
          "title": "sample",
          "summary": "sample",
          "excerpt": "sample",
          "sections": [
            "sample"
          ],
          "links": [
            "sample"
          ],
          "estimatedTokens": 0,
          "structure": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.graphql.execute": {
    "input": {
      "query": "sample",
      "operationName": "sample",
      "variables": {}
    },
    "output": {
      "data": {},
      "errors": [
        "sample"
      ],
      "extensions": {}
    }
  },
  "knowledge.graphql.schema": {
    "input": {},
    "output": {
      "language": "sample",
      "domain": "sample",
      "schema": "sample"
    }
  },
  "knowledge.ingest.artifact": {
    "input": {
      "artifactId": "sample",
      "path": "sample",
      "uri": "sample",
      "sourceType": "url",
      "title": "sample",
      "sessionId": "sample",
      "tags": [
        "sample"
      ],
      "folderPath": "sample",
      "allowPrivateHosts": false,
      "metadata": {}
    },
    "output": {
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.ingest.bookmarks": {
    "input": {
      "path": "sample",
      "sessionId": "sample",
      "allowPrivateHosts": false,
      "metadata": {}
    },
    "output": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.ingest.browserHistory": {
    "input": {
      "limit": 0,
      "sinceMs": 0,
      "browsers": [
        "sample"
      ],
      "sourceKinds": [
        "sample"
      ],
      "homeOverride": "sample",
      "sessionId": "sample",
      "connectorId": "sample",
      "metadata": {}
    },
    "output": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ],
      "profiles": [
        {
          "family": "sample",
          "browser": "sample",
          "profileName": "sample",
          "profilePath": "sample",
          "historyPath": "sample",
          "bookmarksPath": "sample"
        }
      ]
    }
  },
  "knowledge.ingest.connector": {
    "input": null,
    "output": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.ingest.url": {
    "input": {
      "url": "sample",
      "title": "sample",
      "sourceType": "url",
      "sessionId": "sample",
      "tags": [
        "sample"
      ],
      "folderPath": "sample",
      "allowPrivateHosts": false,
      "metadata": {}
    },
    "output": {
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.ingest.urls": {
    "input": {
      "path": "sample",
      "sessionId": "sample",
      "allowPrivateHosts": false,
      "metadata": {}
    },
    "output": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.issue.review": {
    "input": {
      "id": "sample",
      "action": "sample",
      "reviewer": "sample",
      "value": {}
    },
    "output": {
      "ok": false,
      "issue": {
        "id": "sample",
        "severity": "sample",
        "code": "sample",
        "message": "sample",
        "status": "sample",
        "sourceId": "sample",
        "nodeId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "node": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "suppression": {},
      "appliedFacts": {}
    }
  },
  "knowledge.issues.list": {
    "input": {
      "limit": 0,
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.item.get": {
    "input": {
      "id": "sample",
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "node": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "issue": {
        "id": "sample",
        "severity": "sample",
        "code": "sample",
        "message": "sample",
        "status": "sample",
        "sourceId": "sample",
        "nodeId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "relatedEdges": [
        {
          "id": "sample",
          "fromKind": "sample",
          "fromId": "sample",
          "toKind": "sample",
          "toId": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "linkedSources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "linkedNodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.job-runs.list": {
    "input": {
      "limit": 0,
      "jobId": "sample"
    },
    "output": {
      "runs": [
        {
          "id": "sample",
          "jobId": "sample",
          "status": "queued",
          "mode": "inline",
          "requestedAt": 0,
          "startedAt": 0,
          "completedAt": 0,
          "error": "sample",
          "result": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.job.get": {
    "input": {
      "jobId": "sample"
    },
    "output": {
      "job": {
        "id": "sample",
        "kind": "lint",
        "title": "sample",
        "description": "sample",
        "defaultMode": "inline",
        "metadata": {}
      }
    }
  },
  "knowledge.job.run": {
    "input": {
      "mode": "inline",
      "sourceIds": [
        "sample"
      ],
      "limit": 0
    },
    "output": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "status": "queued",
        "mode": "inline",
        "requestedAt": 0,
        "startedAt": 0,
        "completedAt": 0,
        "error": "sample",
        "result": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.jobs.list": {
    "input": {},
    "output": {
      "jobs": [
        {
          "id": "sample",
          "kind": "lint",
          "title": "sample",
          "description": "sample",
          "defaultMode": "inline",
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.lint": {
    "input": {},
    "output": {
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.map": {
    "input": {
      "limit": 0,
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false,
      "includeSources": false,
      "includeIssues": false,
      "includeGenerated": false,
      "query": "sample",
      "recordKinds": [
        "sample"
      ],
      "ids": [
        "sample"
      ],
      "linkedToIds": [
        "sample"
      ],
      "nodeKinds": [
        "sample"
      ],
      "sourceTypes": [
        "sample"
      ],
      "sourceStatuses": [
        "sample"
      ],
      "nodeStatuses": [
        "sample"
      ],
      "issueCodes": [
        "sample"
      ],
      "issueStatuses": [
        "sample"
      ],
      "issueSeverities": [
        "sample"
      ],
      "edgeRelations": [
        "sample"
      ],
      "tags": [
        "sample"
      ],
      "minConfidence": 0
    },
    "output": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "generatedAt": 0,
      "width": 0,
      "height": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "totalNodeCount": 0,
      "totalEdgeCount": 0,
      "facets": {
        "recordKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceTypes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueCodes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueSeverities": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "edgeRelations": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "tags": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "homeAssistant": {}
      },
      "nodes": [
        {
          "id": "sample",
          "recordKind": "sample",
          "kind": "sample",
          "title": "sample",
          "summary": "sample",
          "x": 0,
          "y": 0,
          "radius": 0,
          "metadata": {}
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromId": "sample",
          "toId": "sample",
          "source": "sample",
          "target": "sample",
          "fromTitle": "sample",
          "toTitle": "sample",
          "sourceTitle": "sample",
          "targetTitle": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {}
        }
      ],
      "svg": "sample"
    }
  },
  "knowledge.nodes.list": {
    "input": {
      "limit": 0,
      "cursor": "sample",
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "nodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.packet": {
    "input": {
      "task": "sample",
      "writeScope": [
        "sample"
      ],
      "budgetLimit": 0,
      "detail": "compact",
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "task": "sample",
      "writeScope": [
        "sample"
      ],
      "generatedAt": 0,
      "detail": "compact",
      "strategy": "sample",
      "budgetLimit": 0,
      "estimatedTokens": 0,
      "truncated": false,
      "totalCandidates": 0,
      "droppedCount": 0,
      "droppedForBudget": 0,
      "budgetExhausted": false,
      "items": [
        {
          "kind": "sample",
          "id": "sample",
          "title": "sample",
          "summary": "sample",
          "uri": "sample",
          "reason": "sample",
          "score": 0,
          "estimatedTokens": 0,
          "related": [
            "sample"
          ],
          "evidence": [
            "sample"
          ],
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.projection.materialize": {
    "input": {
      "kind": "sample",
      "id": "sample",
      "limit": 0,
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "bundle": {
        "id": "sample",
        "target": {
          "targetId": "sample",
          "kind": "sample",
          "title": "sample",
          "description": "sample",
          "itemId": "sample",
          "defaultPath": "sample",
          "defaultFilename": "sample",
          "metadata": {}
        },
        "generatedAt": 0,
        "pageCount": 0,
        "pages": [
          {
            "path": "sample",
            "title": "sample",
            "format": "sample",
            "content": "sample",
            "itemIds": [
              "sample"
            ],
            "metadata": {}
          }
        ],
        "metadata": {}
      },
      "artifact": {
        "id": "sample",
        "kind": "sample",
        "mimeType": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "createdAt": 0,
        "expiresAt": 0,
        "sourceUri": "sample",
        "acquisitionMode": "sample",
        "fetchMode": "sample",
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactCreated": false
    }
  },
  "knowledge.projection.render": {
    "input": {
      "kind": "sample",
      "id": "sample",
      "limit": 0,
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "id": "sample",
      "target": {
        "targetId": "sample",
        "kind": "sample",
        "title": "sample",
        "description": "sample",
        "itemId": "sample",
        "defaultPath": "sample",
        "defaultFilename": "sample",
        "metadata": {}
      },
      "generatedAt": 0,
      "pageCount": 0,
      "pages": [
        {
          "path": "sample",
          "title": "sample",
          "format": "sample",
          "content": "sample",
          "itemIds": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  },
  "knowledge.projections.list": {
    "input": {
      "limit": 0
    },
    "output": {
      "targets": [
        {
          "targetId": "sample",
          "kind": "sample",
          "title": "sample",
          "description": "sample",
          "itemId": "sample",
          "defaultPath": "sample",
          "defaultFilename": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.refinement.run": {
    "input": {
      "knowledgeSpaceId": "sample",
      "spaceId": "sample",
      "gapIds": [
        "sample"
      ],
      "sourceIds": [
        "sample"
      ],
      "limit": 0,
      "maxRunMs": 0,
      "force": false
    },
    "output": {
      "scannedGaps": 0,
      "candidateGaps": 0,
      "processedGaps": 0,
      "createdGaps": 0,
      "repairableGaps": 0,
      "suppressedGaps": 0,
      "skippedGaps": 0,
      "searched": 0,
      "ingestedSources": 0,
      "linkedRepairs": 0,
      "blockedGaps": 0,
      "closedGaps": 0,
      "queuedTasks": 0,
      "requestedLimit": 0,
      "effectiveLimit": 0,
      "coalesced": false,
      "truncated": false,
      "budgetExhausted": false,
      "taskIds": [
        "sample"
      ],
      "ingestedSourceIds": [
        "sample"
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.refinement.task.cancel": {
    "input": {
      "id": "sample"
    },
    "output": {
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.refinement.task.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.refinement.tasks.list": {
    "input": {
      "limit": 0,
      "spaceId": "sample",
      "knowledgeSpaceId": "sample",
      "state": "sample",
      "subjectKind": "sample",
      "subjectId": "sample",
      "gapId": "sample"
    },
    "output": {
      "tasks": [
        {
          "id": "sample",
          "spaceId": "sample",
          "subjectKind": "sample",
          "subjectId": "sample",
          "subjectTitle": "sample",
          "subjectType": "sample",
          "gapId": "sample",
          "issueId": "sample",
          "state": "detected",
          "priority": "low",
          "trigger": "ingest",
          "budget": {},
          "attemptCount": 0,
          "blockedReason": "sample",
          "nextRepairAttemptAt": 0,
          "acceptedSourceIds": [
            "sample"
          ],
          "ingestedSourceIds": [
            "sample"
          ],
          "rejectedSourceUrls": [
            "sample"
          ],
          "promotedFactCount": 0,
          "sourceAssessments": [
            "sample"
          ],
          "trace": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.reindex": {
    "input": {},
    "output": {
      "status": {
        "ready": false,
        "storagePath": "sample",
        "sourceCount": 0,
        "nodeCount": 0,
        "edgeCount": 0,
        "issueCount": 0,
        "extractionCount": 0,
        "jobRunCount": 0,
        "refinementTaskCount": 0,
        "usageCount": 0,
        "candidateCount": 0,
        "reportCount": 0,
        "scheduleCount": 0
      },
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.report.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "report": {
        "id": "sample",
        "kind": "sample",
        "title": "sample",
        "summary": "sample",
        "highlights": [
          "sample"
        ],
        "metrics": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.reports.list": {
    "input": {
      "limit": 0,
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "reports": [
        {
          "id": "sample",
          "kind": "sample",
          "title": "sample",
          "summary": "sample",
          "highlights": [
            "sample"
          ],
          "metrics": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.schedule.delete": {
    "input": {
      "id": "sample"
    },
    "output": {
      "deleted": false
    }
  },
  "knowledge.schedule.enable": {
    "input": {
      "enabled": false
    },
    "output": {
      "schedule": {
        "id": "sample",
        "jobId": "sample",
        "label": "sample",
        "enabled": false,
        "schedule": {
          "kind": "at",
          "at": 0
        },
        "lastRunAt": 0,
        "nextRunAt": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.schedule.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "schedule": {
        "id": "sample",
        "jobId": "sample",
        "label": "sample",
        "enabled": false,
        "schedule": {
          "kind": "at",
          "at": 0
        },
        "lastRunAt": 0,
        "nextRunAt": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.schedule.save": {
    "input": {
      "id": "sample",
      "jobId": "sample",
      "label": "sample",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "metadata": {}
    },
    "output": {
      "schedule": {
        "id": "sample",
        "jobId": "sample",
        "label": "sample",
        "enabled": false,
        "schedule": {
          "kind": "at",
          "at": 0
        },
        "lastRunAt": 0,
        "nextRunAt": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.schedules.list": {
    "input": {
      "limit": 0
    },
    "output": {
      "schedules": [
        {
          "id": "sample",
          "jobId": "sample",
          "label": "sample",
          "enabled": false,
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "lastRunAt": 0,
          "nextRunAt": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.search": {
    "input": {
      "query": "sample",
      "limit": 0,
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false,
      "includeSources": false,
      "includeNodes": false,
      "metadata": {}
    },
    "output": {
      "results": [
        {
          "kind": "sample",
          "id": "sample",
          "score": 0,
          "reason": "sample",
          "source": {
            "id": "sample",
            "connectorId": "sample",
            "sourceType": "url",
            "title": "sample",
            "sourceUri": "sample",
            "canonicalUri": "sample",
            "summary": "sample",
            "description": "sample",
            "tags": [
              "sample"
            ],
            "folderPath": "sample",
            "status": "sample",
            "artifactId": "sample",
            "contentHash": "sample",
            "lastCrawledAt": 0,
            "crawlError": "sample",
            "sessionId": "sample",
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          },
          "node": {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        }
      ]
    }
  },
  "knowledge.source.extraction.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.sources.list": {
    "input": {
      "limit": 0,
      "cursor": "sample",
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.status": {
    "input": {
      "knowledgeSpaceId": "sample",
      "includeAllSpaces": false
    },
    "output": {
      "ready": false,
      "storagePath": "sample",
      "sourceCount": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "issueCount": 0,
      "extractionCount": 0,
      "jobRunCount": 0,
      "refinementTaskCount": 0,
      "usageCount": 0,
      "candidateCount": 0,
      "reportCount": 0,
      "scheduleCount": 0
    }
  },
  "knowledge.usage.list": {
    "input": {
      "limit": 0,
      "targetKind": "sample",
      "targetId": "sample",
      "usageKind": "sample"
    },
    "output": {
      "usage": [
        {
          "id": "sample",
          "targetKind": "sample",
          "targetId": "sample",
          "usageKind": "sample",
          "task": "sample",
          "sessionId": "sample",
          "score": 0,
          "metadata": {},
          "createdAt": 0
        }
      ]
    }
  },
  "projectPlanning.decisions.list": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "decisions": [
        {
          "id": "sample",
          "title": "sample",
          "context": "sample",
          "decision": "sample",
          "alternatives": [
            "sample"
          ],
          "reasoning": "sample",
          "consequences": [
            "sample"
          ],
          "status": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "projectPlanning.decisions.record": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "decision": {}
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "decision": {
        "id": "sample",
        "title": "sample",
        "context": "sample",
        "decision": "sample",
        "alternatives": [
          "sample"
        ],
        "reasoning": "sample",
        "consequences": [
          "sample"
        ],
        "status": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.evaluate": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "planningId": "sample",
      "state": {}
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "readiness": "sample",
      "gaps": [
        {
          "id": "sample",
          "kind": "sample",
          "severity": "sample",
          "message": "sample",
          "question": {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          },
          "relatedTaskIds": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "nextQuestion": {
        "id": "sample",
        "prompt": "sample",
        "whyItMatters": "sample",
        "recommendedAnswer": "sample",
        "consequence": "sample",
        "status": "sample",
        "answer": "sample",
        "answeredAt": 0,
        "metadata": {}
      },
      "state": {
        "id": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "goal": "sample",
        "scope": "sample",
        "knownContext": [
          "sample"
        ],
        "openQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "answeredQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "decisions": [
          {
            "id": "sample",
            "title": "sample",
            "context": "sample",
            "decision": "sample",
            "alternatives": [
              "sample"
            ],
            "reasoning": "sample",
            "consequences": [
              "sample"
            ],
            "status": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          }
        ],
        "assumptions": [
          "sample"
        ],
        "constraints": [
          "sample"
        ],
        "risks": [
          "sample"
        ],
        "tasks": [
          {
            "id": "sample",
            "title": "sample",
            "why": "sample",
            "status": "sample",
            "dependencies": [
              "sample"
            ],
            "likelyFiles": [
              "sample"
            ],
            "verification": [
              "sample"
            ],
            "canRunConcurrently": false,
            "needsReview": false,
            "blockedOnUserInput": false,
            "recommendedAgent": "sample",
            "metadata": {}
          }
        ],
        "dependencies": [
          "sample"
        ],
        "verificationGates": [
          "sample"
        ],
        "agentAssignments": [
          "sample"
        ],
        "readiness": "sample",
        "executionApproved": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "projectPlanning.language.get": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "language": {
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "terms": [
          "sample"
        ],
        "ambiguities": [
          "sample"
        ],
        "examples": [
          "sample"
        ],
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.language.upsert": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "language": {}
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "language": {
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "terms": [
          "sample"
        ],
        "ambiguities": [
          "sample"
        ],
        "examples": [
          "sample"
        ],
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.state.get": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "planningId": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "state": {
        "id": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "goal": "sample",
        "scope": "sample",
        "knownContext": [
          "sample"
        ],
        "openQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "answeredQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "decisions": [
          {
            "id": "sample",
            "title": "sample",
            "context": "sample",
            "decision": "sample",
            "alternatives": [
              "sample"
            ],
            "reasoning": "sample",
            "consequences": [
              "sample"
            ],
            "status": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          }
        ],
        "assumptions": [
          "sample"
        ],
        "constraints": [
          "sample"
        ],
        "risks": [
          "sample"
        ],
        "tasks": [
          {
            "id": "sample",
            "title": "sample",
            "why": "sample",
            "status": "sample",
            "dependencies": [
              "sample"
            ],
            "likelyFiles": [
              "sample"
            ],
            "verification": [
              "sample"
            ],
            "canRunConcurrently": false,
            "needsReview": false,
            "blockedOnUserInput": false,
            "recommendedAgent": "sample",
            "metadata": {}
          }
        ],
        "dependencies": [
          "sample"
        ],
        "verificationGates": [
          "sample"
        ],
        "agentAssignments": [
          "sample"
        ],
        "readiness": "sample",
        "executionApproved": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.state.upsert": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "state": {}
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "state": {
        "id": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "goal": "sample",
        "scope": "sample",
        "knownContext": [
          "sample"
        ],
        "openQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "answeredQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "decisions": [
          {
            "id": "sample",
            "title": "sample",
            "context": "sample",
            "decision": "sample",
            "alternatives": [
              "sample"
            ],
            "reasoning": "sample",
            "consequences": [
              "sample"
            ],
            "status": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          }
        ],
        "assumptions": [
          "sample"
        ],
        "constraints": [
          "sample"
        ],
        "risks": [
          "sample"
        ],
        "tasks": [
          {
            "id": "sample",
            "title": "sample",
            "why": "sample",
            "status": "sample",
            "dependencies": [
              "sample"
            ],
            "likelyFiles": [
              "sample"
            ],
            "verification": [
              "sample"
            ],
            "canRunConcurrently": false,
            "needsReview": false,
            "blockedOnUserInput": false,
            "recommendedAgent": "sample",
            "metadata": {}
          }
        ],
        "dependencies": [
          "sample"
        ],
        "verificationGates": [
          "sample"
        ],
        "agentAssignments": [
          "sample"
        ],
        "readiness": "sample",
        "executionApproved": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.status": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "passiveOnly": false,
      "counts": {},
      "capabilities": [
        "sample"
      ]
    }
  },
  "projectPlanning.workPlan.clearCompleted": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "statuses": [
        "sample"
      ]
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.snapshot": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "status": "sample",
      "parentTaskId": "sample",
      "chainId": "sample",
      "owner": "sample",
      "limit": 0
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "tasks": [
        {
          "taskId": "sample",
          "projectId": "sample",
          "knowledgeSpaceId": "sample",
          "title": "sample",
          "notes": "sample",
          "owner": "sample",
          "status": "sample",
          "priority": 0,
          "order": 0,
          "source": "sample",
          "tags": [
            "sample"
          ],
          "parentTaskId": "sample",
          "chainId": "sample",
          "phaseId": "sample",
          "agentId": "sample",
          "turnId": "sample",
          "decisionId": "sample",
          "sourceMessageId": "sample",
          "linkedArtifactIds": [
            "sample"
          ],
          "linkedSourceIds": [
            "sample"
          ],
          "linkedNodeIds": [
            "sample"
          ],
          "originSurface": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "completedAt": 0,
          "metadata": {}
        }
      ],
      "counts": {
        "total": 0,
        "pending": 0,
        "in_progress": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0
      },
      "updatedAt": 0
    }
  },
  "projectPlanning.workPlan.task.create": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {}
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.delete": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "taskId": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.get": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "taskId": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.status": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "taskId": "sample",
      "status": "sample",
      "reason": "sample",
      "source": "sample"
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.update": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "taskId": "sample",
      "patch": {}
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.tasks.list": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "status": "sample",
      "parentTaskId": "sample",
      "chainId": "sample",
      "owner": "sample",
      "limit": 0
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "tasks": [
        {
          "taskId": "sample",
          "projectId": "sample",
          "knowledgeSpaceId": "sample",
          "title": "sample",
          "notes": "sample",
          "owner": "sample",
          "status": "sample",
          "priority": 0,
          "order": 0,
          "source": "sample",
          "tags": [
            "sample"
          ],
          "parentTaskId": "sample",
          "chainId": "sample",
          "phaseId": "sample",
          "agentId": "sample",
          "turnId": "sample",
          "decisionId": "sample",
          "sourceMessageId": "sample",
          "linkedArtifactIds": [
            "sample"
          ],
          "linkedSourceIds": [
            "sample"
          ],
          "linkedNodeIds": [
            "sample"
          ],
          "originSurface": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "completedAt": 0,
          "metadata": {}
        }
      ],
      "counts": {
        "total": 0,
        "pending": 0,
        "in_progress": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0
      },
      "updatedAt": 0
    }
  },
  "projectPlanning.workPlan.tasks.reorder": {
    "input": {
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "orderedTaskIds": [
        "sample"
      ]
    },
    "output": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "tasks": [
        {
          "taskId": "sample",
          "projectId": "sample",
          "knowledgeSpaceId": "sample",
          "title": "sample",
          "notes": "sample",
          "owner": "sample",
          "status": "sample",
          "priority": 0,
          "order": 0,
          "source": "sample",
          "tags": [
            "sample"
          ],
          "parentTaskId": "sample",
          "chainId": "sample",
          "phaseId": "sample",
          "agentId": "sample",
          "turnId": "sample",
          "decisionId": "sample",
          "sourceMessageId": "sample",
          "linkedArtifactIds": [
            "sample"
          ],
          "linkedSourceIds": [
            "sample"
          ],
          "linkedNodeIds": [
            "sample"
          ],
          "originSurface": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "completedAt": 0,
          "metadata": {}
        }
      ],
      "counts": {
        "total": 0,
        "pending": 0,
        "in_progress": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0
      },
      "updatedAt": 0
    }
  },
  "mcp.config.get": {
    "input": {},
    "output": {
      "locations": [
        {
          "scope": "sample",
          "kind": "sample",
          "path": "sample",
          "writable": false
        }
      ],
      "servers": [
        {
          "name": "sample",
          "command": "sample",
          "args": [
            "sample"
          ],
          "envKeys": [
            "sample"
          ],
          "role": "sample",
          "trustMode": "sample",
          "allowedPaths": [
            "sample"
          ],
          "allowedHosts": [
            "sample"
          ],
          "source": {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        }
      ]
    }
  },
  "mcp.config.reload": {
    "input": {},
    "output": {
      "reload": {
        "added": 0,
        "changed": 0,
        "removed": 0,
        "unchanged": 0,
        "servers": [
          {
            "name": "sample",
            "action": "added",
            "connected": false
          }
        ]
      },
      "config": {
        "locations": [
          {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        ],
        "servers": [
          {
            "name": "sample",
            "command": "sample",
            "args": [
              "sample"
            ],
            "envKeys": [
              "sample"
            ],
            "role": "sample",
            "trustMode": "sample",
            "allowedPaths": [
              "sample"
            ],
            "allowedHosts": [
              "sample"
            ],
            "source": {
              "scope": "sample",
              "kind": "sample",
              "path": "sample",
              "writable": false
            }
          }
        ]
      }
    }
  },
  "mcp.servers.list": {
    "input": {},
    "output": {
      "servers": [
        {
          "name": "sample",
          "connected": false
        }
      ],
      "security": [
        {}
      ],
      "sandboxBindings": [
        {}
      ]
    }
  },
  "mcp.servers.remove": {
    "input": {
      "serverName": "sample",
      "scope": "project"
    },
    "output": {
      "scope": "project",
      "path": "sample",
      "removed": false,
      "reload": {
        "added": 0,
        "changed": 0,
        "removed": 0,
        "unchanged": 0,
        "servers": [
          {
            "name": "sample",
            "action": "added",
            "connected": false
          }
        ]
      },
      "config": {
        "locations": [
          {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        ],
        "servers": [
          {
            "name": "sample",
            "command": "sample",
            "args": [
              "sample"
            ],
            "envKeys": [
              "sample"
            ],
            "role": "sample",
            "trustMode": "sample",
            "allowedPaths": [
              "sample"
            ],
            "allowedHosts": [
              "sample"
            ],
            "source": {
              "scope": "sample",
              "kind": "sample",
              "path": "sample",
              "writable": false
            }
          }
        ]
      }
    }
  },
  "mcp.servers.upsert": {
    "input": {
      "scope": "project",
      "server": {
        "name": "sample",
        "command": "sample",
        "args": [
          "sample"
        ],
        "env": {},
        "envKeys": [
          "sample"
        ],
        "role": "sample",
        "trustMode": "sample",
        "allowedPaths": [
          "sample"
        ],
        "allowedHosts": [
          "sample"
        ]
      }
    },
    "output": {
      "scope": "project",
      "path": "sample",
      "removed": false,
      "reload": {
        "added": 0,
        "changed": 0,
        "removed": 0,
        "unchanged": 0,
        "servers": [
          {
            "name": "sample",
            "action": "added",
            "connected": false
          }
        ]
      },
      "config": {
        "locations": [
          {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        ],
        "servers": [
          {
            "name": "sample",
            "command": "sample",
            "args": [
              "sample"
            ],
            "envKeys": [
              "sample"
            ],
            "role": "sample",
            "trustMode": "sample",
            "allowedPaths": [
              "sample"
            ],
            "allowedHosts": [
              "sample"
            ],
            "source": {
              "scope": "sample",
              "kind": "sample",
              "path": "sample",
              "writable": false
            }
          }
        ]
      }
    }
  },
  "mcp.tools.list": {
    "input": {},
    "output": {
      "tools": [
        {
          "qualifiedName": "sample",
          "serverName": "sample",
          "toolName": "sample",
          "description": "sample"
        }
      ]
    }
  },
  "media.analyze": {
    "input": {
      "providerId": "sample",
      "artifact": {
        "id": "sample",
        "artifactId": "sample",
        "mimeType": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "metadata": {}
      },
      "artifactId": "sample",
      "prompt": "sample",
      "modelId": "sample",
      "metadata": {}
    },
    "output": {
      "providerId": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "text": "sample",
      "metadata": {}
    }
  },
  "media.generate": {
    "input": {
      "providerId": "sample",
      "prompt": "sample",
      "outputMimeType": "sample",
      "modelId": "sample",
      "options": {},
      "metadata": {}
    },
    "output": {
      "providerId": "sample",
      "artifacts": [
        {
          "id": "sample",
          "artifactId": "sample",
          "mimeType": "sample",
          "dataBase64": "sample",
          "uri": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "acquisitionMode": "inline-data",
          "fetchMode": "not-applicable",
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  },
  "media.providers.list": {
    "input": {},
    "output": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "capabilities": [
            "sample"
          ]
        }
      ]
    }
  },
  "media.transform": {
    "input": {
      "providerId": "sample",
      "artifact": {
        "id": "sample",
        "artifactId": "sample",
        "mimeType": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "metadata": {}
      },
      "operation": "sample",
      "outputMimeType": "sample",
      "options": {},
      "metadata": {}
    },
    "output": {
      "providerId": "sample",
      "artifact": {
        "id": "sample",
        "artifactId": "sample",
        "mimeType": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "acquisitionMode": "inline-data",
        "fetchMode": "not-applicable",
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "multimodal.analyze": {
    "input": {
      "artifactId": "sample",
      "artifact": {
        "artifactId": "sample",
        "mimeType": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "allowPrivateHosts": false,
        "filename": "sample",
        "metadata": {}
      },
      "prompt": "sample",
      "imageProviderId": "sample",
      "audioProviderId": "sample",
      "modelId": "sample",
      "language": "sample",
      "detail": "compact",
      "allowPrivateHosts": false,
      "includePacket": false,
      "writeback": {
        "sessionId": "sample",
        "title": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "metadata": {}
      },
      "sessionId": "sample",
      "metadata": {}
    },
    "output": {
      "analysis": {
        "id": "sample",
        "kind": "sample",
        "artifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "providerIds": [
          "sample"
        ],
        "summary": "sample",
        "text": "sample",
        "labels": [
          "sample"
        ],
        "entities": [
          "sample"
        ],
        "segments": [
          {
            "kind": "sample",
            "title": "sample",
            "text": "sample",
            "startMs": 0,
            "endMs": 0,
            "confidence": 0,
            "metadata": {}
          }
        ],
        "metadata": {}
      },
      "packet": {
        "detail": "sample",
        "budgetLimit": 0,
        "estimatedTokens": 0,
        "rendered": "sample",
        "highlights": [
          "sample"
        ]
      },
      "writeback": {
        "analysisArtifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "knowledgeSourceId": "sample",
        "metadata": {}
      }
    }
  },
  "multimodal.packet": {
    "input": {
      "analysis": {
        "id": "sample",
        "kind": "sample",
        "artifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "providerIds": [
          "sample"
        ],
        "summary": "sample",
        "text": "sample",
        "labels": [
          "sample"
        ],
        "entities": [
          "sample"
        ],
        "segments": [
          {
            "kind": "sample",
            "title": "sample",
            "text": "sample",
            "startMs": 0,
            "endMs": 0,
            "confidence": 0,
            "metadata": {}
          }
        ],
        "metadata": {}
      },
      "detail": "compact",
      "budgetLimit": 0
    },
    "output": {
      "packet": {
        "detail": "sample",
        "budgetLimit": 0,
        "estimatedTokens": 0,
        "rendered": "sample",
        "highlights": [
          "sample"
        ]
      }
    }
  },
  "multimodal.providers.list": {
    "input": {},
    "output": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "transport": "sample",
          "capabilities": [
            "sample"
          ],
          "configured": false,
          "metadata": {}
        }
      ]
    }
  },
  "multimodal.status": {
    "input": {},
    "output": {
      "enabled": false,
      "providerCount": 0,
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "transport": "sample",
          "capabilities": [
            "sample"
          ],
          "configured": false,
          "metadata": {}
        }
      ],
      "note": "sample"
    }
  },
  "multimodal.writeback": {
    "input": {
      "analysis": {
        "id": "sample",
        "kind": "sample",
        "artifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "providerIds": [
          "sample"
        ],
        "summary": "sample",
        "text": "sample",
        "labels": [
          "sample"
        ],
        "entities": [
          "sample"
        ],
        "segments": [
          {
            "kind": "sample",
            "title": "sample",
            "text": "sample",
            "startMs": 0,
            "endMs": 0,
            "confidence": 0,
            "metadata": {}
          }
        ],
        "metadata": {}
      },
      "sessionId": "sample",
      "title": "sample",
      "tags": [
        "sample"
      ],
      "folderPath": "sample",
      "metadata": {}
    },
    "output": {
      "writeback": {
        "analysisArtifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "knowledgeSourceId": "sample",
        "metadata": {}
      }
    }
  },
  "memory.doctor": {
    "input": {},
    "output": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      },
      "embeddings": {
        "activeProviderId": "sample",
        "providers": [
          {
            "id": "sample",
            "label": "sample",
            "state": "healthy",
            "dimensions": 0,
            "configured": false,
            "deterministic": false,
            "detail": "sample",
            "metadata": {}
          }
        ],
        "asyncProviders": [
          "sample"
        ],
        "syncProviders": [
          "sample"
        ],
        "warnings": [
          "sample"
        ]
      },
      "checkedAt": 0
    }
  },
  "memory.embeddings.default.set": {
    "input": {
      "providerId": "sample"
    },
    "output": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      },
      "embeddings": {
        "activeProviderId": "sample",
        "providers": [
          {
            "id": "sample",
            "label": "sample",
            "state": "healthy",
            "dimensions": 0,
            "configured": false,
            "deterministic": false,
            "detail": "sample",
            "metadata": {}
          }
        ],
        "asyncProviders": [
          "sample"
        ],
        "syncProviders": [
          "sample"
        ],
        "warnings": [
          "sample"
        ]
      },
      "checkedAt": 0
    }
  },
  "memory.projections.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "projection": {
        "id": "sample",
        "filename": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "tags": [
          "sample"
        ],
        "confidence": 0,
        "reviewState": "fresh",
        "validFrom": 0,
        "validUntil": 0,
        "status": "active"
      },
      "markdown": "sample"
    }
  },
  "memory.projections.list": {
    "input": {},
    "output": {
      "projections": [
        {
          "id": "sample",
          "filename": "sample",
          "scope": "session",
          "cls": "decision",
          "summary": "sample",
          "tags": [
            "sample"
          ],
          "confidence": 0,
          "reviewState": "fresh",
          "validFrom": 0,
          "validUntil": 0,
          "status": "active"
        }
      ]
    }
  },
  "memory.records.add": {
    "input": {
      "cls": "decision",
      "summary": "sample",
      "scope": "session",
      "detail": "sample",
      "tags": [
        "sample"
      ],
      "provenance": [
        {
          "kind": "session",
          "ref": "sample",
          "label": "sample"
        }
      ],
      "review": {
        "state": "fresh",
        "confidence": 0,
        "reviewedBy": "sample",
        "staleReason": "sample"
      }
    },
    "output": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.records.delete": {
    "input": {
      "id": "sample"
    },
    "output": {
      "id": "sample",
      "deleted": false
    }
  },
  "memory.records.export": {
    "input": {
      "scope": "session",
      "cls": "decision",
      "tags": [
        "sample"
      ],
      "query": "sample",
      "semantic": false,
      "since": 0,
      "reviewState": [
        "fresh"
      ],
      "minConfidence": 0,
      "provenanceKinds": [
        "session"
      ],
      "staleOnly": false,
      "limit": 0
    },
    "output": {
      "bundle": {
        "schemaVersion": "v1",
        "exportedAt": 0,
        "scope": "session",
        "recordCount": 0,
        "linkCount": 0,
        "records": [
          {
            "id": "sample",
            "scope": "session",
            "cls": "decision",
            "summary": "sample",
            "detail": "sample",
            "tags": [
              "sample"
            ],
            "provenance": [
              {
                "kind": "session",
                "ref": "sample",
                "label": "sample"
              }
            ],
            "reviewState": "fresh",
            "confidence": 0,
            "reviewedAt": 0,
            "reviewedBy": "sample",
            "staleReason": "sample",
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "links": [
          {
            "fromId": "sample",
            "toId": "sample",
            "relation": "sample",
            "createdAt": 0
          }
        ]
      }
    }
  },
  "memory.records.get": {
    "input": {
      "id": "sample"
    },
    "output": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.records.import": {
    "input": {
      "bundle": {
        "schemaVersion": "v1",
        "exportedAt": 0,
        "scope": "session",
        "recordCount": 0,
        "linkCount": 0,
        "records": [
          {
            "id": "sample",
            "scope": "session",
            "cls": "decision",
            "summary": "sample",
            "detail": "sample",
            "tags": [
              "sample"
            ],
            "provenance": [
              {
                "kind": "session",
                "ref": "sample",
                "label": "sample"
              }
            ],
            "reviewState": "fresh",
            "confidence": 0,
            "reviewedAt": 0,
            "reviewedBy": "sample",
            "staleReason": "sample",
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "links": [
          {
            "fromId": "sample",
            "toId": "sample",
            "relation": "sample",
            "createdAt": 0
          }
        ]
      }
    },
    "output": {
      "result": {
        "importedRecords": 0,
        "skippedRecords": 0,
        "importedLinks": 0
      }
    }
  },
  "memory.records.links.add": {
    "input": {
      "id": "sample",
      "toId": "sample",
      "relation": "sample"
    },
    "output": {
      "link": {
        "fromId": "sample",
        "toId": "sample",
        "relation": "sample",
        "createdAt": 0
      }
    }
  },
  "memory.records.links.list": {
    "input": {
      "id": "sample"
    },
    "output": {
      "links": [
        {
          "fromId": "sample",
          "toId": "sample",
          "relation": "sample",
          "createdAt": 0
        }
      ]
    }
  },
  "memory.records.list": {
    "input": {
      "scope": "session",
      "cls": "decision",
      "tags": [
        "sample"
      ],
      "query": "sample",
      "semantic": false,
      "since": 0,
      "reviewState": [
        "fresh"
      ],
      "minConfidence": 0,
      "provenanceKinds": [
        "session"
      ],
      "staleOnly": false,
      "limit": 0
    },
    "output": {
      "records": [
        {
          "id": "sample",
          "scope": "session",
          "cls": "decision",
          "summary": "sample",
          "detail": "sample",
          "tags": [
            "sample"
          ],
          "provenance": [
            {
              "kind": "session",
              "ref": "sample",
              "label": "sample"
            }
          ],
          "reviewState": "fresh",
          "confidence": 0,
          "reviewedAt": 0,
          "reviewedBy": "sample",
          "staleReason": "sample",
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "memory.records.search": {
    "input": {
      "scope": "session",
      "cls": "decision",
      "tags": [
        "sample"
      ],
      "query": "sample",
      "semantic": false,
      "since": 0,
      "reviewState": [
        "fresh"
      ],
      "minConfidence": 0,
      "provenanceKinds": [
        "session"
      ],
      "staleOnly": false,
      "limit": 0,
      "recall": false
    },
    "output": {
      "records": [
        {
          "id": "sample",
          "scope": "session",
          "cls": "decision",
          "summary": "sample",
          "detail": "sample",
          "tags": [
            "sample"
          ],
          "provenance": [
            {
              "kind": "session",
              "ref": "sample",
              "label": "sample"
            }
          ],
          "reviewState": "fresh",
          "confidence": 0,
          "reviewedAt": 0,
          "reviewedBy": "sample",
          "staleReason": "sample",
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "mode": "literal",
      "requestedSemantic": false,
      "indexUnavailableReason": "sample",
      "caveat": "sample",
      "recallFiltered": false,
      "excludedFlaggedCount": 0,
      "excludedBelowFloorCount": 0,
      "totalBeforeRecallFilter": 0,
      "recallFloor": 0
    }
  },
  "memory.records.search-semantic": {
    "input": {
      "scope": "session",
      "cls": "decision",
      "tags": [
        "sample"
      ],
      "query": "sample",
      "semantic": false,
      "since": 0,
      "reviewState": [
        "fresh"
      ],
      "minConfidence": 0,
      "provenanceKinds": [
        "session"
      ],
      "staleOnly": false,
      "limit": 0
    },
    "output": {
      "results": [
        {
          "record": {
            "id": "sample",
            "scope": "session",
            "cls": "decision",
            "summary": "sample",
            "detail": "sample",
            "tags": [
              "sample"
            ],
            "provenance": [
              {
                "kind": "session",
                "ref": "sample",
                "label": "sample"
              }
            ],
            "reviewState": "fresh",
            "confidence": 0,
            "reviewedAt": 0,
            "reviewedBy": "sample",
            "staleReason": "sample",
            "createdAt": 0,
            "updatedAt": 0
          },
          "distance": 0,
          "similarity": 0,
          "score": 0
        }
      ]
    }
  },
  "memory.records.update": {
    "input": {
      "id": "sample",
      "scope": "session",
      "summary": "sample",
      "detail": "sample",
      "tags": [
        "sample"
      ],
      "validFrom": 0,
      "validUntil": 0
    },
    "output": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.records.update-review": {
    "input": {
      "id": "sample",
      "state": "fresh",
      "confidence": 0,
      "reviewedBy": "sample",
      "staleReason": "sample"
    },
    "output": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.review-queue": {
    "input": {
      "limit": 0,
      "scope": "session"
    },
    "output": {
      "records": [
        {}
      ]
    }
  },
  "memory.vector.rebuild": {
    "input": {},
    "output": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      }
    }
  },
  "memory.vector.stats": {
    "input": {},
    "output": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      }
    }
  },
  "pairing.handoff.complete": {
    "input": {
      "accept": {
        "notifications": {
          "endpoint": "sample",
          "keys": {
            "p256dh": "sample",
            "auth": "sample"
          },
          "deviceId": "sample"
        },
        "relay": false,
        "passkey": {
          "rpId": "sample",
          "origin": "sample",
          "credentialId": "sample",
          "publicKeyCose": "sample"
        }
      }
    },
    "output": {
      "results": [
        {
          "kind": "sample",
          "status": "sample",
          "detail": "sample"
        }
      ]
    }
  },
  "pairing.handoff.create": {
    "input": {
      "name": "sample",
      "offers": [
        "sample"
      ]
    },
    "output": {
      "token": {
        "id": "sample",
        "name": "sample",
        "token": "sample",
        "createdAt": 0
      },
      "offers": [
        {
          "kind": "sample",
          "available": false,
          "vapidPublicKey": "sample"
        }
      ],
      "fragment": "sample",
      "deepLink": "sample",
      "posture": {
        "origin": "sample",
        "scheme": "sample",
        "privateNetwork": false,
        "secureContext": false,
        "notice": "sample",
        "capabilities": [
          {
            "capability": "sample",
            "available": false,
            "reason": "sample"
          }
        ]
      }
    }
  },
  "pairing.posture.get": {
    "input": {
      "origin": "sample"
    },
    "output": {
      "posture": {
        "origin": "sample",
        "scheme": "sample",
        "privateNetwork": false,
        "secureContext": false,
        "notice": "sample",
        "capabilities": [
          {
            "capability": "sample",
            "available": false,
            "reason": "sample"
          }
        ]
      }
    }
  },
  "pairing.tokens.create": {
    "input": {
      "name": "sample"
    },
    "output": {
      "token": {
        "id": "sample",
        "name": "sample",
        "token": "sample",
        "createdAt": 0
      }
    }
  },
  "pairing.tokens.delete": {
    "input": {
      "id": "sample"
    },
    "output": {
      "id": "sample",
      "revoked": false
    }
  },
  "pairing.tokens.list": {
    "input": null,
    "output": {
      "tokens": [
        {
          "id": "sample",
          "name": "sample",
          "createdAt": 0,
          "lastSeenAt": 0
        }
      ],
      "legacySharedRevoked": false
    }
  },
  "pairing.tokens.migrate": {
    "input": {
      "name": "sample"
    },
    "output": {
      "token": {
        "id": "sample",
        "name": "sample",
        "token": "sample",
        "createdAt": 0
      }
    }
  },
  "pairing.tokens.rename": {
    "input": {
      "id": "sample",
      "name": "sample"
    },
    "output": {
      "id": "sample",
      "renamed": false
    }
  },
  "pairing.tokens.revokeShared": {
    "input": null,
    "output": {
      "legacySharedRevoked": false
    }
  },
  "panels.list": {
    "input": {},
    "output": {
      "panels": [
        {
          "id": "sample",
          "name": "sample",
          "category": "sample",
          "description": "sample",
          "open": false
        }
      ]
    }
  },
  "panels.open": {
    "input": {
      "id": "sample",
      "pane": "sample"
    },
    "output": {
      "opened": false,
      "id": "sample",
      "pane": "top"
    }
  },
  "permissions.rules.delete": {
    "input": {
      "ruleId": "sample"
    },
    "output": {
      "deleted": false
    }
  },
  "permissions.rules.list": {
    "input": {},
    "output": {
      "rules": [
        {
          "id": "sample",
          "effect": "allow",
          "tier": "exact",
          "tool": "sample",
          "description": "sample",
          "createdAt": 0
        }
      ]
    }
  },
  "principals.create": {
    "input": {
      "name": "sample",
      "kind": "user",
      "identities": [
        {
          "channel": "sample",
          "value": "sample"
        }
      ],
      "metadata": {}
    },
    "output": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "principals.delete": {
    "input": {
      "principalId": "sample"
    },
    "output": {
      "principalId": "sample",
      "deleted": false
    }
  },
  "principals.get": {
    "input": {
      "principalId": "sample"
    },
    "output": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "principals.list": {
    "input": {},
    "output": {
      "principals": [
        {
          "id": "sample",
          "name": "sample",
          "kind": "user",
          "identities": [
            {
              "channel": "sample",
              "value": "sample"
            }
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "principals.resolve": {
    "input": {
      "channel": "sample",
      "value": "sample"
    },
    "output": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "known": false
    }
  },
  "principals.update": {
    "input": {
      "principalId": "sample",
      "name": "sample",
      "kind": "user",
      "identities": [
        {
          "channel": "sample",
          "value": "sample"
        }
      ],
      "metadata": {}
    },
    "output": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "providers.get": {
    "input": {
      "providerId": "sample"
    },
    "output": {
      "providerId": "sample",
      "active": false,
      "modelCount": 0,
      "runtime": {
        "auth": {
          "mode": "api-key",
          "configured": false,
          "detail": "sample",
          "envVars": [
            "sample"
          ],
          "routes": [
            {
              "route": "sample",
              "label": "sample",
              "configured": false,
              "usable": false,
              "freshness": "sample",
              "detail": "sample",
              "envVars": [
                "sample"
              ],
              "secretKeys": [
                "sample"
              ],
              "serviceNames": [
                "sample"
              ],
              "providerId": "sample",
              "repairHints": [
                "sample"
              ]
            }
          ]
        },
        "models": {
          "defaultModel": "sample",
          "models": [
            "sample"
          ],
          "embeddingModel": "sample",
          "embeddingDimensions": 0,
          "aliases": [
            "sample"
          ],
          "suppressedModelRegistryKeys": [
            "sample"
          ]
        },
        "usage": {
          "streaming": false,
          "toolCalling": false,
          "parallelTools": false,
          "promptCaching": false,
          "cost": {
            "source": "catalog",
            "currency": "sample",
            "inputPerMillionTokens": 0,
            "outputPerMillionTokens": 0,
            "detail": "sample"
          },
          "notes": [
            "sample"
          ]
        },
        "policy": {
          "local": false,
          "dataRetention": "sample",
          "streamProtocol": "sample",
          "reasoningMode": "sample",
          "supportedReasoningEfforts": [
            "sample"
          ],
          "cacheStrategy": "sample",
          "notes": [
            "sample"
          ]
        },
        "notes": [
          "sample"
        ]
      },
      "models": [
        {
          "id": "sample",
          "registryKey": "sample",
          "displayName": "sample",
          "selectable": false,
          "contextWindow": 0,
          "tier": "sample",
          "pricing": {
            "inputPerMillionTokens": 0,
            "outputPerMillionTokens": 0,
            "currency": "USD",
            "source": "user",
            "asOf": "sample"
          }
        }
      ]
    }
  },
  "providers.list": {
    "input": {},
    "output": {
      "providers": [
        {
          "providerId": "sample",
          "active": false,
          "modelCount": 0,
          "runtime": {
            "auth": {
              "mode": "api-key",
              "configured": false,
              "detail": "sample",
              "envVars": [
                "sample"
              ],
              "routes": [
                {
                  "route": "sample",
                  "label": "sample",
                  "configured": false,
                  "usable": false,
                  "freshness": "sample",
                  "detail": "sample",
                  "envVars": [
                    "sample"
                  ],
                  "secretKeys": [
                    "sample"
                  ],
                  "serviceNames": [
                    "sample"
                  ],
                  "providerId": "sample",
                  "repairHints": [
                    "sample"
                  ]
                }
              ]
            },
            "models": {
              "defaultModel": "sample",
              "models": [
                "sample"
              ],
              "embeddingModel": "sample",
              "embeddingDimensions": 0,
              "aliases": [
                "sample"
              ],
              "suppressedModelRegistryKeys": [
                "sample"
              ]
            },
            "usage": {
              "streaming": false,
              "toolCalling": false,
              "parallelTools": false,
              "promptCaching": false,
              "cost": {
                "source": "catalog",
                "currency": "sample",
                "inputPerMillionTokens": 0,
                "outputPerMillionTokens": 0,
                "detail": "sample"
              },
              "notes": [
                "sample"
              ]
            },
            "policy": {
              "local": false,
              "dataRetention": "sample",
              "streamProtocol": "sample",
              "reasoningMode": "sample",
              "supportedReasoningEfforts": [
                "sample"
              ],
              "cacheStrategy": "sample",
              "notes": [
                "sample"
              ]
            },
            "notes": [
              "sample"
            ]
          },
          "models": [
            {
              "id": "sample",
              "registryKey": "sample",
              "displayName": "sample",
              "selectable": false,
              "contextWindow": 0,
              "tier": "sample",
              "pricing": {
                "inputPerMillionTokens": 0,
                "outputPerMillionTokens": 0,
                "currency": "USD",
                "source": "user",
                "asOf": "sample"
              }
            }
          ]
        }
      ]
    }
  },
  "providers.usage.get": {
    "input": {
      "providerId": "sample"
    },
    "output": {
      "providerId": "sample",
      "active": false,
      "currentModelRegistryKey": "sample",
      "pricingSource": "user",
      "pricingAsOf": "sample",
      "models": [
        {
          "id": "sample",
          "registryKey": "sample",
          "displayName": "sample",
          "selectable": false,
          "contextWindow": 0,
          "tier": "sample",
          "pricing": {
            "inputPerMillionTokens": 0,
            "outputPerMillionTokens": 0,
            "currency": "USD",
            "source": "user",
            "asOf": "sample"
          }
        }
      ],
      "usage": {
        "streaming": false,
        "toolCalling": false,
        "parallelTools": false,
        "promptCaching": false,
        "cost": {
          "source": "catalog",
          "currency": "sample",
          "inputPerMillionTokens": 0,
          "outputPerMillionTokens": 0,
          "detail": "sample"
        },
        "notes": [
          "sample"
        ]
      }
    }
  },
  "push.subscriptions.create": {
    "input": {
      "endpoint": "sample",
      "keys": {
        "p256dh": "sample",
        "auth": "sample"
      },
      "deviceId": "sample"
    },
    "output": {
      "subscription": {
        "id": "sample",
        "principalId": "sample",
        "deviceId": "sample",
        "endpointOrigin": "sample",
        "endpointHash": "sample",
        "createdAt": 0,
        "lastDeliveryAt": 0,
        "lastOutcome": "sample",
        "consecutiveFailures": 0
      }
    }
  },
  "push.subscriptions.delete": {
    "input": {
      "subscriptionId": "sample"
    },
    "output": {
      "subscriptionId": "sample",
      "deleted": false
    }
  },
  "push.subscriptions.list": {
    "input": null,
    "output": {
      "subscriptions": [
        {
          "id": "sample",
          "principalId": "sample",
          "deviceId": "sample",
          "endpointOrigin": "sample",
          "endpointHash": "sample",
          "createdAt": 0,
          "lastDeliveryAt": 0,
          "lastOutcome": "sample",
          "consecutiveFailures": 0
        }
      ]
    }
  },
  "push.subscriptions.reconcile": {
    "input": {
      "deviceId": "sample",
      "endpoint": "sample",
      "keys": {
        "p256dh": "sample",
        "auth": "sample"
      }
    },
    "output": {
      "subscription": {
        "id": "sample",
        "principalId": "sample",
        "deviceId": "sample",
        "endpointOrigin": "sample",
        "endpointHash": "sample",
        "createdAt": 0,
        "lastDeliveryAt": 0,
        "lastOutcome": "sample",
        "consecutiveFailures": 0
      },
      "drift": "sample"
    }
  },
  "push.subscriptions.verify": {
    "input": {
      "subscriptionId": "sample"
    },
    "output": {
      "receipt": {
        "subscriptionId": "sample",
        "endpointOrigin": "sample",
        "outcome": "sample",
        "httpStatus": 0,
        "detail": "sample"
      }
    }
  },
  "push.vapid.get": {
    "input": null,
    "output": {
      "publicKey": "sample"
    }
  },
  "quota.fanout.get": {
    "input": {
      "provider": "sample",
      "agentCount": 0,
      "callsPerAgent": 0
    },
    "output": {
      "provider": "sample",
      "verdict": "likely-exhausts",
      "reason": "sample",
      "evidence": {
        "recentRateLimitCount": 0,
        "activeCooldownMs": 0,
        "observedRemaining": 0,
        "observedLimit": 0,
        "requestedAgents": 0
      }
    }
  },
  "quota.snapshot.get": {
    "input": {
      "provider": "sample"
    },
    "output": {
      "provider": "sample",
      "hasSignal": false,
      "observedAt": 0,
      "remaining": 0,
      "limit": 0,
      "resetAt": 0,
      "activeCooldownMs": 0,
      "recentRateLimitCount": 0
    }
  },
  "stepup.challenge.mint": {
    "input": {
      "rendezvousId": "sample",
      "sessionId": "sample",
      "ttlMs": 0
    },
    "output": {
      "challengeId": "sample",
      "challenge": "sample",
      "expiresAt": 0
    }
  },
  "stepup.credentials.register": {
    "input": {
      "rpId": "sample",
      "origin": "sample",
      "credentialId": "sample",
      "publicKeyCose": "sample",
      "signCount": 0,
      "userVerification": "required",
      "label": "sample"
    },
    "output": {
      "credential": {
        "credentialId": "sample",
        "label": "sample",
        "createdAt": 0,
        "signCount": 0
      }
    }
  },
  "remote.node_host.contract": {
    "input": {},
    "output": {
      "contract": {
        "schemaVersion": 0,
        "transport": "sample",
        "basePath": "sample",
        "peerKinds": [
          "node"
        ],
        "workTypes": [
          "invoke"
        ],
        "scopes": [
          "sample"
        ],
        "recommendedHeartbeatMs": 0,
        "recommendedWorkPullMs": 0,
        "endpoints": [
          {
            "id": "sample",
            "method": "GET",
            "path": "sample",
            "auth": "none",
            "description": "sample",
            "requiredScope": "sample",
            "inputSchema": {},
            "outputSchema": {}
          }
        ],
        "workCompletionStatuses": [
          "queued"
        ],
        "metadata": {}
      }
    }
  },
  "remote.pair.requests.approve": {
    "input": {
      "requestId": "sample",
      "note": "sample",
      "label": "sample",
      "metadata": {}
    },
    "output": {
      "request": {
        "id": "sample",
        "peerKind": "node",
        "requestedId": "sample",
        "label": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "requestedBy": "remote",
        "status": "pending",
        "challengePreview": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "approvedAt": 0,
        "verifiedAt": 0,
        "rejectedAt": 0,
        "expiresAt": 0,
        "peerId": "sample",
        "remoteAddress": "sample",
        "metadata": {}
      },
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      }
    }
  },
  "remote.pair.requests.list": {
    "input": {},
    "output": {
      "requests": [
        {
          "id": "sample",
          "peerKind": "node",
          "requestedId": "sample",
          "label": "sample",
          "platform": "sample",
          "deviceFamily": "sample",
          "version": "sample",
          "clientMode": "sample",
          "capabilities": [
            "sample"
          ],
          "commands": [
            "sample"
          ],
          "requestedBy": "remote",
          "status": "pending",
          "challengePreview": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "approvedAt": 0,
          "verifiedAt": 0,
          "rejectedAt": 0,
          "expiresAt": 0,
          "peerId": "sample",
          "remoteAddress": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "remote.pair.requests.reject": {
    "input": {
      "requestId": "sample",
      "note": "sample",
      "label": "sample",
      "metadata": {}
    },
    "output": {
      "request": {
        "id": "sample",
        "peerKind": "node",
        "requestedId": "sample",
        "label": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "requestedBy": "remote",
        "status": "pending",
        "challengePreview": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "approvedAt": 0,
        "verifiedAt": 0,
        "rejectedAt": 0,
        "expiresAt": 0,
        "peerId": "sample",
        "remoteAddress": "sample",
        "metadata": {}
      }
    }
  },
  "remote.peers.disconnect": {
    "input": {
      "peerId": "sample",
      "note": "sample",
      "requeueClaimedWork": false
    },
    "output": {
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      }
    }
  },
  "remote.peers.invoke": {
    "input": {
      "peerId": "sample",
      "command": "sample",
      "payload": "sample",
      "priority": "default",
      "waitMs": 0,
      "timeoutMs": 0,
      "sessionId": "sample",
      "routeId": "sample",
      "automationRunId": "sample",
      "automationJobId": "sample",
      "approvalId": "sample",
      "metadata": {}
    },
    "output": {
      "work": {
        "id": "sample",
        "peerId": "sample",
        "peerKind": "node",
        "type": "invoke",
        "command": "sample",
        "priority": "default",
        "status": "queued",
        "payload": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "queuedBy": "sample",
        "claimedAt": 0,
        "claimTokenId": "sample",
        "leaseExpiresAt": 0,
        "completedAt": 0,
        "timeoutMs": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "automationRunId": "sample",
        "automationJobId": "sample",
        "approvalId": "sample",
        "result": "sample",
        "error": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "metadata": {}
      },
      "completed": false
    }
  },
  "remote.peers.list": {
    "input": {},
    "output": {
      "peers": [
        {
          "id": "sample",
          "kind": "node",
          "label": "sample",
          "requestedId": "sample",
          "platform": "sample",
          "deviceFamily": "sample",
          "version": "sample",
          "clientMode": "sample",
          "capabilities": [
            "sample"
          ],
          "commands": [
            "sample"
          ],
          "permissions": {},
          "status": "paired",
          "pairedAt": 0,
          "verifiedAt": 0,
          "lastSeenAt": 0,
          "lastConnectedAt": 0,
          "lastDisconnectedAt": 0,
          "lastRemoteAddress": "sample",
          "activeTokenId": "sample",
          "tokens": [
            {
              "id": "sample",
              "label": "sample",
              "scopes": [
                "sample"
              ],
              "issuedAt": 0,
              "lastUsedAt": 0,
              "rotatedAt": 0,
              "revokedAt": 0,
              "fingerprint": "sample"
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "remote.peers.token.revoke": {
    "input": {
      "peerId": "sample",
      "tokenId": "sample",
      "note": "sample"
    },
    "output": {
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      }
    }
  },
  "remote.peers.token.rotate": {
    "input": {
      "peerId": "sample",
      "label": "sample",
      "scopes": [
        "sample"
      ]
    },
    "output": {
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      },
      "token": {
        "id": "sample",
        "label": "sample",
        "scopes": [
          "sample"
        ],
        "issuedAt": 0,
        "lastUsedAt": 0,
        "rotatedAt": 0,
        "revokedAt": 0,
        "fingerprint": "sample",
        "value": "sample"
      }
    }
  },
  "remote.snapshot": {
    "input": {},
    "output": {
      "daemon": {
        "transportState": "sample",
        "isRunning": false,
        "reconnectAttempts": 0,
        "runningJobCount": 0,
        "lastError": "sample"
      },
      "acp": {
        "transportState": "sample",
        "activeConnectionIds": [
          "sample"
        ],
        "totalSpawned": 0,
        "totalFailed": 0,
        "lastError": "sample"
      },
      "registry": {
        "pools": 0,
        "contracts": 0,
        "artifacts": 0,
        "poolEntries": [
          {
            "id": "sample",
            "label": "sample",
            "trustClass": "sample",
            "preferredTemplate": "sample",
            "maxRunners": 0,
            "runnerIds": [
              "sample"
            ]
          }
        ],
        "contractEntries": [
          {
            "id": "sample",
            "runnerId": "sample",
            "label": "sample",
            "template": "sample",
            "poolId": "sample",
            "taskId": "sample",
            "sourceTransport": "sample",
            "trustClass": "sample",
            "executionProtocol": "sample",
            "reviewMode": "sample",
            "communicationLane": "sample",
            "transportState": "sample",
            "lastError": "sample"
          }
        ],
        "artifactEntries": [
          {
            "id": "sample",
            "runnerId": "sample",
            "createdAt": 0,
            "status": "sample",
            "summary": "sample",
            "error": "sample"
          }
        ]
      },
      "supervisor": {
        "sessions": 0,
        "degraded": 0,
        "capturedAt": 0,
        "entries": [
          {
            "runnerId": "sample",
            "label": "sample",
            "transportState": "sample",
            "heartbeat": "sample",
            "taskId": "sample"
          }
        ]
      },
      "distributed": {
        "pairRequests": [
          {
            "id": "sample",
            "peerKind": "node",
            "requestedId": "sample",
            "label": "sample",
            "platform": "sample",
            "deviceFamily": "sample",
            "version": "sample",
            "clientMode": "sample",
            "capabilities": [
              "sample"
            ],
            "commands": [
              "sample"
            ],
            "requestedBy": "remote",
            "status": "pending",
            "challengePreview": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "approvedAt": 0,
            "verifiedAt": 0,
            "rejectedAt": 0,
            "expiresAt": 0,
            "peerId": "sample",
            "remoteAddress": "sample",
            "metadata": {}
          }
        ],
        "peers": [
          {
            "id": "sample",
            "kind": "node",
            "label": "sample",
            "requestedId": "sample",
            "platform": "sample",
            "deviceFamily": "sample",
            "version": "sample",
            "clientMode": "sample",
            "capabilities": [
              "sample"
            ],
            "commands": [
              "sample"
            ],
            "permissions": {},
            "status": "paired",
            "pairedAt": 0,
            "verifiedAt": 0,
            "lastSeenAt": 0,
            "lastConnectedAt": 0,
            "lastDisconnectedAt": 0,
            "lastRemoteAddress": "sample",
            "activeTokenId": "sample",
            "tokens": [
              {
                "id": "sample",
                "label": "sample",
                "scopes": [
                  "sample"
                ],
                "issuedAt": 0,
                "lastUsedAt": 0,
                "rotatedAt": 0,
                "revokedAt": 0,
                "fingerprint": "sample"
              }
            ],
            "metadata": {}
          }
        ],
        "work": [
          {
            "id": "sample",
            "peerId": "sample",
            "peerKind": "node",
            "type": "invoke",
            "command": "sample",
            "priority": "default",
            "status": "queued",
            "payload": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "queuedBy": "sample",
            "claimedAt": 0,
            "claimTokenId": "sample",
            "leaseExpiresAt": 0,
            "completedAt": 0,
            "timeoutMs": 0,
            "sessionId": "sample",
            "routeId": "sample",
            "automationRunId": "sample",
            "automationJobId": "sample",
            "approvalId": "sample",
            "result": "sample",
            "error": "sample",
            "telemetry": {
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0
              },
              "llmCallCount": 0,
              "toolCallCount": 0,
              "turnCount": 0,
              "modelId": "sample",
              "providerId": "sample",
              "reasoningSummaryPresent": false,
              "source": "local-agent"
            },
            "metadata": {}
          }
        ],
        "audit": [
          {
            "id": "sample",
            "action": "pair-requested",
            "actor": "sample",
            "peerId": "sample",
            "requestId": "sample",
            "workId": "sample",
            "createdAt": 0,
            "note": "sample",
            "metadata": {}
          }
        ]
      }
    }
  },
  "remote.work.cancel": {
    "input": {
      "workId": "sample",
      "reason": "sample"
    },
    "output": {
      "work": {
        "id": "sample",
        "peerId": "sample",
        "peerKind": "node",
        "type": "invoke",
        "command": "sample",
        "priority": "default",
        "status": "queued",
        "payload": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "queuedBy": "sample",
        "claimedAt": 0,
        "claimTokenId": "sample",
        "leaseExpiresAt": 0,
        "completedAt": 0,
        "timeoutMs": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "automationRunId": "sample",
        "automationJobId": "sample",
        "approvalId": "sample",
        "result": "sample",
        "error": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "metadata": {}
      }
    }
  },
  "remote.work.list": {
    "input": {},
    "output": {
      "work": [
        {
          "id": "sample",
          "peerId": "sample",
          "peerKind": "node",
          "type": "invoke",
          "command": "sample",
          "priority": "default",
          "status": "queued",
          "payload": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "queuedBy": "sample",
          "claimedAt": 0,
          "claimTokenId": "sample",
          "leaseExpiresAt": 0,
          "completedAt": 0,
          "timeoutMs": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "automationRunId": "sample",
          "automationJobId": "sample",
          "approvalId": "sample",
          "result": "sample",
          "error": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "metadata": {}
        }
      ]
    }
  },
  "tailscale.get": {
    "input": null,
    "output": {
      "available": false,
      "loggedIn": false,
      "magicDnsName": "sample",
      "httpsUrl": "sample",
      "detail": "sample",
      "lastServe": {
        "at": 0,
        "command": "sample",
        "ok": false,
        "url": "sample",
        "detail": "sample"
      }
    }
  },
  "tailscale.serve.run": {
    "input": null,
    "output": {
      "receipt": {
        "at": 0,
        "command": "sample",
        "ok": false,
        "url": "sample",
        "detail": "sample"
      },
      "publicBaseUrlUpdated": false
    }
  },
  "review.snapshot": {
    "input": {},
    "output": {
      "apiFamilies": [
        "sample"
      ],
      "routes": [
        "sample"
      ],
      "sessions": 0,
      "tasks": 0,
      "pendingApprovals": 0,
      "remoteContracts": 0,
      "panels": 0
    }
  },
  "rewind.apply": {
    "input": {
      "sessionId": "sample",
      "turnId": "sample",
      "scope": "files",
      "confirm": false,
      "confirmToken": "sample"
    },
    "output": {
      "receipt": {
        "sessionId": "sample",
        "turnId": "sample",
        "scope": "files",
        "appliedAt": 0,
        "files": {
          "restored": false,
          "checkpointId": "sample",
          "safetyCheckpointId": "sample",
          "restoredFileCount": 0,
          "removedFileCount": 0
        },
        "conversation": {
          "rewound": false,
          "droppedMessages": 0,
          "undoSnapshotId": "sample"
        },
        "undo": {
          "files": {
            "restoreCheckpointId": "sample"
          },
          "conversation": {
            "undoSnapshotId": "sample"
          }
        },
        "warnings": [
          "sample"
        ]
      },
      "refused": false,
      "refusal": {
        "reason": "sample",
        "confirmField": "sample",
        "planMethod": "sample",
        "options": [
          "sample"
        ]
      }
    }
  },
  "rewind.plan": {
    "input": {
      "sessionId": "sample",
      "turnId": "sample",
      "scope": "files"
    },
    "output": {
      "sessionId": "sample",
      "turnId": "sample",
      "scope": "files",
      "token": "sample",
      "expiresAt": 0,
      "files": {
        "available": false,
        "checkpointId": "sample",
        "checkpointLabel": "sample",
        "affectedFileCount": 0
      },
      "conversation": {
        "available": false,
        "messagesToDrop": 0,
        "messagesRemaining": 0
      },
      "warnings": [
        "sample"
      ]
    }
  },
  "routes.bindings.create": {
    "input": {
      "id": "sample",
      "kind": "sample",
      "surfaceKind": "sample",
      "surfaceId": "sample",
      "externalId": "sample",
      "sessionPolicy": "sample",
      "threadPolicy": "sample",
      "deliveryGuarantee": "sample",
      "threadId": "sample",
      "channelId": "sample",
      "sessionId": "sample",
      "jobId": "sample",
      "runId": "sample",
      "title": "sample",
      "metadata": {}
    },
    "output": {
      "id": "sample",
      "kind": "session",
      "surfaceKind": "tui",
      "surfaceId": "sample",
      "externalId": "sample",
      "sessionPolicy": "create-or-bind",
      "threadPolicy": "preserve",
      "deliveryGuarantee": "best-effort",
      "threadId": "sample",
      "channelId": "sample",
      "sessionId": "sample",
      "jobId": "sample",
      "runId": "sample",
      "title": "sample",
      "lastSeenAt": 0,
      "createdAt": 0,
      "updatedAt": 0,
      "metadata": {}
    }
  },
  "routes.bindings.delete": {
    "input": {
      "bindingId": "sample"
    },
    "output": {
      "removed": false,
      "id": "sample"
    }
  },
  "routes.bindings.list": {
    "input": {},
    "output": {
      "bindings": [
        {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "routes.bindings.update": {
    "input": {
      "bindingId": "sample",
      "sessionPolicy": "sample",
      "threadPolicy": "sample",
      "deliveryGuarantee": "sample",
      "threadId": "sample",
      "channelId": "sample",
      "sessionId": "sample",
      "jobId": "sample",
      "runId": "sample",
      "title": "sample",
      "metadata": {}
    },
    "output": {
      "id": "sample",
      "kind": "session",
      "surfaceKind": "tui",
      "surfaceId": "sample",
      "externalId": "sample",
      "sessionPolicy": "create-or-bind",
      "threadPolicy": "preserve",
      "deliveryGuarantee": "best-effort",
      "threadId": "sample",
      "channelId": "sample",
      "sessionId": "sample",
      "jobId": "sample",
      "runId": "sample",
      "title": "sample",
      "lastSeenAt": 0,
      "createdAt": 0,
      "updatedAt": 0,
      "metadata": {}
    }
  },
  "routes.snapshot": {
    "input": {},
    "output": {
      "totalBindings": 0,
      "activeBindings": 0,
      "recentBindings": 0,
      "bindings": [
        {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "surfaces.list": {
    "input": {},
    "output": {
      "surfaces": [
        {
          "id": "sample",
          "kind": "sample",
          "label": "sample",
          "enabled": false,
          "state": "sample",
          "configuredAt": 0,
          "lastSeenAt": 0,
          "defaultRouteId": "sample",
          "accountId": "sample",
          "capabilities": [
            "sample"
          ],
          "metadata": {}
        }
      ]
    }
  },
  "runtime.metrics.get": {
    "input": {},
    "output": {
      "counters": {},
      "gauges": {},
      "histograms": {},
      "toolFormat": {
        "byModel": {},
        "byClass": {}
      }
    }
  },
  "scheduler.capacity": {
    "input": {},
    "output": {
      "slotsTotal": 0,
      "slotsInUse": 0,
      "queueDepth": 0,
      "oldestQueuedAgeMs": 0
    }
  },
  "services.install": {
    "input": {},
    "output": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.restart": {
    "input": {},
    "output": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.start": {
    "input": {},
    "output": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.status": {
    "input": {},
    "output": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.stop": {
    "input": {},
    "output": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.uninstall": {
    "input": {},
    "output": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "sessions.changes.get": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "checkpointCount": 0,
      "checkpointIds": [
        "sample"
      ],
      "from": "sample",
      "to": "sample",
      "files": [
        "sample"
      ],
      "unifiedDiff": "sample",
      "stat": "sample"
    }
  },
  "sessions.close": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.contextUsage.get": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "estimatedContextTokens": 0,
      "contextWindow": 0,
      "contextUsagePct": 0,
      "contextRemainingTokens": 0,
      "estimated": false
    }
  },
  "sessions.create": {
    "input": {
      "title": "sample",
      "surfaceKind": "sample",
      "surfaceId": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.delete": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "deleted": false
    }
  },
  "sessions.detach": {
    "input": {
      "sessionId": "sample",
      "surfaceId": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.followUp": {
    "input": {
      "body": "sample",
      "surfaceKind": "sample",
      "surfaceId": "sample",
      "routing": {
        "providerId": "sample",
        "modelId": "sample",
        "providerSelection": "inherit-current",
        "providerFailurePolicy": "ordered-fallbacks",
        "fallbackModels": [
          "sample"
        ],
        "helperModel": {
          "providerId": "sample",
          "modelId": "sample"
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "tools": [
          "sample"
        ],
        "reasoningEffort": "instant"
      }
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "message": {
        "id": "sample",
        "sessionId": "sample",
        "role": "user",
        "body": "sample",
        "createdAt": 0,
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "routeId": "sample",
        "agentId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "metadata": {}
      },
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      },
      "mode": "spawn",
      "agentId": "sample"
    }
  },
  "sessions.get": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "body": "sample",
          "createdAt": 0,
          "surfaceKind": "sample",
          "surfaceId": "sample",
          "routeId": "sample",
          "agentId": "sample",
          "userId": "sample",
          "displayName": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "sessions.inputs.cancel": {
    "input": {
      "sessionId": "sample",
      "inputId": "sample"
    },
    "output": {
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      }
    }
  },
  "sessions.inputs.deliver": {
    "input": {
      "sessionId": "sample",
      "inputId": "sample",
      "consumed": false
    },
    "output": {
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      }
    }
  },
  "sessions.inputs.list": {
    "input": {
      "sessionId": "sample",
      "limit": 0,
      "state": "sample",
      "since": 0
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "inputs": [
        {
          "id": "sample",
          "sessionId": "sample",
          "intent": "submit",
          "state": "queued",
          "correlationId": "sample",
          "causationId": "sample",
          "body": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "routeId": "sample",
          "surfaceKind": "sample",
          "surfaceId": "sample",
          "externalId": "sample",
          "threadId": "sample",
          "userId": "sample",
          "displayName": "sample",
          "activeAgentId": "sample",
          "metadata": {},
          "routing": {
            "providerId": "sample",
            "modelId": "sample",
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ],
            "helperModel": {
              "providerId": "sample",
              "modelId": "sample"
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "tools": [
              "sample"
            ],
            "reasoningEffort": "instant"
          },
          "error": "sample"
        }
      ]
    }
  },
  "sessions.integration.snapshot": {
    "input": {},
    "output": {
      "id": "sample",
      "title": "sample",
      "status": "sample",
      "recoveryState": "sample",
      "projectRoot": "sample",
      "isResumed": false,
      "resumedFromId": "sample",
      "compactionState": "sample",
      "lastCompactedAt": 0,
      "lineage": [
        "sample"
      ]
    }
  },
  "sessions.list": {
    "input": {},
    "output": {
      "totals": {
        "sessions": 0,
        "active": 0,
        "closed": 0
      },
      "sessions": [
        {
          "id": "sample",
          "kind": "sample",
          "project": "sample",
          "title": "sample",
          "status": "active",
          "createdAt": 0,
          "updatedAt": 0,
          "lastMessageAt": 0,
          "closedAt": 0,
          "lastActivityAt": 0,
          "messageCount": 0,
          "retainedMessageCount": 0,
          "pendingInputCount": 0,
          "routeIds": [
            "sample"
          ],
          "surfaceKinds": [
            "sample"
          ],
          "participants": [
            {
              "surfaceKind": "sample",
              "surfaceId": "sample",
              "externalId": "sample",
              "userId": "sample",
              "displayName": "sample",
              "routeId": "sample",
              "lastSeenAt": 0
            }
          ],
          "activeAgentId": "sample",
          "lastAgentId": "sample",
          "lastError": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "sessions.messages.create": {
    "input": {
      "body": "sample",
      "surfaceKind": "sample",
      "surfaceId": "sample",
      "kind": "sample",
      "routing": {
        "providerId": "sample",
        "modelId": "sample",
        "providerSelection": "inherit-current",
        "providerFailurePolicy": "ordered-fallbacks",
        "fallbackModels": [
          "sample"
        ],
        "helperModel": {
          "providerId": "sample",
          "modelId": "sample"
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "tools": [
          "sample"
        ],
        "reasoningEffort": "instant"
      }
    },
    "output": {
      "messageId": "sample",
      "routedTo": "sample",
      "sessionId": "sample"
    }
  },
  "sessions.messages.list": {
    "input": {
      "sessionId": "sample",
      "limit": 0,
      "before": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "body": "sample",
          "createdAt": 0,
          "surfaceKind": "sample",
          "surfaceId": "sample",
          "routeId": "sample",
          "agentId": "sample",
          "userId": "sample",
          "displayName": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "sessions.permissionMode.get": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "sessionId": "sample",
      "mode": "plan"
    }
  },
  "sessions.permissionMode.set": {
    "input": {
      "sessionId": "sample",
      "mode": "plan"
    },
    "output": {
      "sessionId": "sample",
      "mode": "plan",
      "previousMode": "plan"
    }
  },
  "sessions.register": {
    "input": {
      "sessionId": "sample",
      "kind": "tui",
      "project": "sample",
      "title": "sample",
      "participant": {
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "routeId": "sample",
        "lastSeenAt": 0
      },
      "reopen": false
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "reopened": false,
      "conflict": {
        "status": "closed"
      }
    }
  },
  "sessions.reopen": {
    "input": {
      "sessionId": "sample"
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.search": {
    "input": {
      "query": "sample",
      "project": "sample",
      "kind": "sample",
      "surfaceKind": "sample",
      "status": "active",
      "includeClosed": false,
      "limit": 0,
      "cursor": "sample"
    },
    "output": {
      "sessions": [
        {
          "id": "sample",
          "kind": "sample",
          "project": "sample",
          "title": "sample",
          "status": "active",
          "createdAt": 0,
          "updatedAt": 0,
          "lastMessageAt": 0,
          "closedAt": 0,
          "lastActivityAt": 0,
          "messageCount": 0,
          "retainedMessageCount": 0,
          "pendingInputCount": 0,
          "routeIds": [
            "sample"
          ],
          "surfaceKinds": [
            "sample"
          ],
          "participants": [
            {
              "surfaceKind": "sample",
              "surfaceId": "sample",
              "externalId": "sample",
              "userId": "sample",
              "displayName": "sample",
              "routeId": "sample",
              "lastSeenAt": 0
            }
          ],
          "activeAgentId": "sample",
          "lastAgentId": "sample",
          "lastError": "sample",
          "metadata": {}
        }
      ],
      "nextCursor": "sample",
      "hasMore": false
    }
  },
  "sessions.steer": {
    "input": {
      "body": "sample",
      "surfaceKind": "sample",
      "surfaceId": "sample",
      "routing": {
        "providerId": "sample",
        "modelId": "sample",
        "providerSelection": "inherit-current",
        "providerFailurePolicy": "ordered-fallbacks",
        "fallbackModels": [
          "sample"
        ],
        "helperModel": {
          "providerId": "sample",
          "modelId": "sample"
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "tools": [
          "sample"
        ],
        "reasoningEffort": "instant"
      },
      "allowSpawnFallback": false
    },
    "output": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "message": {
        "id": "sample",
        "sessionId": "sample",
        "role": "user",
        "body": "sample",
        "createdAt": 0,
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "routeId": "sample",
        "agentId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "metadata": {}
      },
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      },
      "mode": "spawn",
      "agentId": "sample"
    }
  },
  "security.settings": {
    "input": {},
    "output": {
      "settings": [
        {
          "key": "sample",
          "type": "setting",
          "featureId": "sample",
          "defaultState": "sample",
          "currentState": "sample",
          "securityRelevant": false,
          "summary": "sample",
          "insecureWhen": "sample",
          "enablementEffect": "sample",
          "enablementRequirements": [
            "sample"
          ],
          "operationalNotes": [
            "sample"
          ]
        }
      ]
    }
  },
  "settings.snapshot": {
    "input": {},
    "output": {
      "available": false,
      "reason": "sample"
    }
  },
  "skills.create": {
    "input": {
      "name": "sample",
      "description": "sample",
      "body": "sample",
      "metadata": {}
    },
    "output": {
      "skill": {
        "name": "sample",
        "description": "sample",
        "metadata": {},
        "updatedAt": 0,
        "body": "sample"
      }
    }
  },
  "skills.delete": {
    "input": {
      "name": "sample"
    },
    "output": {
      "name": "sample",
      "deleted": false
    }
  },
  "skills.get": {
    "input": {
      "name": "sample"
    },
    "output": {
      "skill": {
        "name": "sample",
        "description": "sample",
        "metadata": {},
        "updatedAt": 0,
        "body": "sample"
      }
    }
  },
  "skills.list": {
    "input": {},
    "output": {
      "skills": [
        {
          "name": "sample",
          "description": "sample",
          "metadata": {},
          "updatedAt": 0
        }
      ]
    }
  },
  "skills.update": {
    "input": {
      "name": "sample",
      "description": "sample",
      "body": "sample",
      "metadata": {}
    },
    "output": {
      "skill": {
        "name": "sample",
        "description": "sample",
        "metadata": {},
        "updatedAt": 0,
        "body": "sample"
      }
    }
  },
  "tasks.cancel": {
    "input": {
      "taskId": "sample"
    },
    "output": {
      "retried": false,
      "task": {
        "id": "sample",
        "kind": "exec",
        "title": "sample",
        "description": "sample",
        "status": "queued",
        "owner": "sample",
        "cancellable": false,
        "parentTaskId": "sample",
        "childTaskIds": [
          "sample"
        ],
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "currentAttempt": 0,
          "delayMs": 0,
          "backoff": "fixed",
          "retryOn": [
            "network"
          ]
        },
        "retryDelayMs": 0,
        "retryAt": 0,
        "exitCode": 0,
        "error": "sample",
        "result": "sample",
        "correlationId": "sample",
        "turnId": "sample"
      },
      "agentId": "sample"
    }
  },
  "tasks.create": {
    "input": {
      "task": "sample",
      "model": "sample",
      "tools": [
        "sample"
      ],
      "provider": "sample",
      "routing": {
        "providerId": "sample",
        "modelId": "sample",
        "providerSelection": "inherit-current",
        "providerFailurePolicy": "ordered-fallbacks",
        "fallbackModels": [
          "sample"
        ],
        "helperModel": {
          "providerId": "sample",
          "modelId": "sample"
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "tools": [
          "sample"
        ],
        "reasoningEffort": "instant"
      },
      "sessionId": "sample",
      "routeId": "sample",
      "surfaceKind": "sample",
      "surfaceId": "sample",
      "externalId": "sample",
      "threadId": "sample",
      "userId": "sample",
      "displayName": "sample",
      "title": "sample",
      "metadata": {}
    },
    "output": {
      "acknowledged": false,
      "mode": "sample",
      "sessionId": "sample",
      "agentId": "sample",
      "status": "sample",
      "task": "sample",
      "model": "sample",
      "tools": [
        "sample"
      ]
    }
  },
  "tasks.get": {
    "input": {
      "taskId": "sample"
    },
    "output": {
      "task": {
        "id": "sample",
        "kind": "exec",
        "title": "sample",
        "description": "sample",
        "status": "queued",
        "owner": "sample",
        "cancellable": false,
        "parentTaskId": "sample",
        "childTaskIds": [
          "sample"
        ],
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "currentAttempt": 0,
          "delayMs": 0,
          "backoff": "fixed",
          "retryOn": [
            "network"
          ]
        },
        "retryDelayMs": 0,
        "retryAt": 0,
        "exitCode": 0,
        "error": "sample",
        "result": "sample",
        "correlationId": "sample",
        "turnId": "sample"
      }
    }
  },
  "tasks.list": {
    "input": {},
    "output": {
      "queued": 0,
      "running": 0,
      "blocked": 0,
      "totals": {
        "created": 0,
        "completed": 0,
        "failed": 0,
        "cancelled": 0
      },
      "tasks": [
        {
          "id": "sample",
          "kind": "exec",
          "title": "sample",
          "status": "queued",
          "owner": "sample",
          "parentTaskId": "sample",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "error": "sample"
        }
      ]
    }
  },
  "tasks.retry": {
    "input": {
      "taskId": "sample"
    },
    "output": {
      "retried": false,
      "task": {
        "id": "sample",
        "kind": "exec",
        "title": "sample",
        "description": "sample",
        "status": "queued",
        "owner": "sample",
        "cancellable": false,
        "parentTaskId": "sample",
        "childTaskIds": [
          "sample"
        ],
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "currentAttempt": 0,
          "delayMs": 0,
          "backoff": "fixed",
          "retryOn": [
            "network"
          ]
        },
        "retryDelayMs": 0,
        "retryAt": 0,
        "exitCode": 0,
        "error": "sample",
        "result": "sample",
        "correlationId": "sample",
        "turnId": "sample"
      },
      "agentId": "sample"
    }
  },
  "tasks.status": {
    "input": {
      "agentId": "sample"
    },
    "output": {
      "agentId": "sample",
      "task": "sample",
      "status": "sample",
      "model": "sample",
      "tools": [
        "sample"
      ],
      "durationMs": 0,
      "toolCallCount": 0,
      "progress": "sample",
      "error": "sample"
    }
  },
  "telemetry.errors.list": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "items": [
        {
          "id": "sample",
          "domain": "sample",
          "type": "sample",
          "timestamp": 0,
          "severity": "debug",
          "traceId": "sample",
          "sessionId": "sample",
          "turnId": "sample",
          "agentId": "sample",
          "taskId": "sample",
          "source": "sample",
          "message": "sample",
          "payload": "sample",
          "attributes": {},
          "error": {
            "name": "sample",
            "message": "sample",
            "summary": "sample",
            "hint": "sample",
            "code": "sample",
            "category": "authentication",
            "source": "provider",
            "recoverable": false,
            "statusCode": 0,
            "provider": "sample",
            "operation": "sample",
            "phase": "sample",
            "requestId": "sample",
            "providerCode": "sample",
            "providerType": "sample",
            "retryAfterMs": 0
          }
        }
      ],
      "pageInfo": {
        "limit": 0,
        "returned": 0,
        "hasMore": false,
        "cursor": "sample",
        "nextCursor": "sample"
      }
    }
  },
  "telemetry.events.list": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "items": [
        {
          "id": "sample",
          "domain": "sample",
          "type": "sample",
          "timestamp": 0,
          "severity": "debug",
          "traceId": "sample",
          "sessionId": "sample",
          "turnId": "sample",
          "agentId": "sample",
          "taskId": "sample",
          "source": "sample",
          "message": "sample",
          "payload": "sample",
          "attributes": {},
          "error": {
            "name": "sample",
            "message": "sample",
            "summary": "sample",
            "hint": "sample",
            "code": "sample",
            "category": "authentication",
            "source": "provider",
            "recoverable": false,
            "statusCode": 0,
            "provider": "sample",
            "operation": "sample",
            "phase": "sample",
            "requestId": "sample",
            "providerCode": "sample",
            "providerType": "sample",
            "retryAfterMs": 0
          }
        }
      ],
      "pageInfo": {
        "limit": 0,
        "returned": 0,
        "hasMore": false,
        "cursor": "sample",
        "nextCursor": "sample"
      }
    }
  },
  "telemetry.metrics.get": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "generatedAt": 0,
      "runtime": {
        "sessionId": "sample",
        "sessionStatus": "sample",
        "traceContext": {
          "traceId": "sample",
          "rootSpanId": "sample",
          "exportActive": false,
          "endpoint": "sample"
        },
        "sessionCorrelationId": "sample",
        "currentTurnCorrelationId": "sample",
        "dbAvailable": false,
        "dbPath": "sample",
        "tasks": {
          "total": 0,
          "queued": 0,
          "running": 0,
          "blocked": 0
        },
        "agents": {
          "total": 0,
          "active": 0
        },
        "approvals": {
          "pending": 0
        }
      },
      "sessionMetrics": {
        "turns": 0,
        "toolCalls": 0,
        "toolErrors": 0,
        "agentsSpawned": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "permissionPrompts": 0,
        "permissionDenials": 0,
        "errors": 0,
        "warnings": 0
      },
      "aggregates": {
        "totalEvents": 0,
        "totalErrors": 0,
        "totalWarnings": 0,
        "totalSpans": 0,
        "byDomain": {},
        "byEventType": {},
        "errorsByCategory": {}
      }
    }
  },
  "telemetry.otlp.logs": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "resourceLogs": [
        {}
      ]
    }
  },
  "telemetry.otlp.metrics": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "resourceMetrics": [
        {}
      ]
    }
  },
  "telemetry.otlp.traces": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "resourceSpans": [
        {}
      ]
    }
  },
  "telemetry.snapshot": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "generatedAt": 0,
      "service": {
        "name": "sample",
        "version": "sample"
      },
      "capabilities": {
        "signals": {
          "events": false,
          "errors": false,
          "metrics": false,
          "traces": false
        },
        "encodings": {
          "json": false,
          "sse": false,
          "otlpJson": {
            "traces": false,
            "metrics": false,
            "logs": false
          }
        }
      },
      "runtime": {
        "sessionId": "sample",
        "sessionStatus": "sample",
        "traceContext": {
          "traceId": "sample",
          "rootSpanId": "sample",
          "exportActive": false,
          "endpoint": "sample"
        },
        "sessionCorrelationId": "sample",
        "currentTurnCorrelationId": "sample",
        "dbAvailable": false,
        "dbPath": "sample",
        "tasks": {
          "total": 0,
          "queued": 0,
          "running": 0,
          "blocked": 0
        },
        "agents": {
          "total": 0,
          "active": 0
        },
        "approvals": {
          "pending": 0
        }
      },
      "sessionMetrics": {
        "turns": 0,
        "toolCalls": 0,
        "toolErrors": 0,
        "agentsSpawned": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "permissionPrompts": 0,
        "permissionDenials": 0,
        "errors": 0,
        "warnings": 0
      },
      "aggregates": {
        "totalEvents": 0,
        "totalErrors": 0,
        "totalWarnings": 0,
        "totalSpans": 0,
        "byDomain": {},
        "byEventType": {},
        "errorsByCategory": {}
      },
      "recent": {
        "events": {
          "version": 0,
          "view": "safe",
          "rawAccessible": false,
          "items": [
            {
              "id": "sample",
              "domain": "sample",
              "type": "sample",
              "timestamp": 0,
              "severity": "debug",
              "traceId": "sample",
              "sessionId": "sample",
              "turnId": "sample",
              "agentId": "sample",
              "taskId": "sample",
              "source": "sample",
              "message": "sample",
              "payload": "sample",
              "attributes": {},
              "error": {
                "name": "sample",
                "message": "sample",
                "summary": "sample",
                "hint": "sample",
                "code": "sample",
                "category": "authentication",
                "source": "provider",
                "recoverable": false,
                "statusCode": 0,
                "provider": "sample",
                "operation": "sample",
                "phase": "sample",
                "requestId": "sample",
                "providerCode": "sample",
                "providerType": "sample",
                "retryAfterMs": 0
              }
            }
          ],
          "pageInfo": {
            "limit": 0,
            "returned": 0,
            "hasMore": false,
            "cursor": "sample",
            "nextCursor": "sample"
          }
        },
        "errors": {
          "version": 0,
          "view": "safe",
          "rawAccessible": false,
          "items": [
            {
              "id": "sample",
              "domain": "sample",
              "type": "sample",
              "timestamp": 0,
              "severity": "debug",
              "traceId": "sample",
              "sessionId": "sample",
              "turnId": "sample",
              "agentId": "sample",
              "taskId": "sample",
              "source": "sample",
              "message": "sample",
              "payload": "sample",
              "attributes": {},
              "error": {
                "name": "sample",
                "message": "sample",
                "summary": "sample",
                "hint": "sample",
                "code": "sample",
                "category": "authentication",
                "source": "provider",
                "recoverable": false,
                "statusCode": 0,
                "provider": "sample",
                "operation": "sample",
                "phase": "sample",
                "requestId": "sample",
                "providerCode": "sample",
                "providerType": "sample",
                "retryAfterMs": 0
              }
            }
          ],
          "pageInfo": {
            "limit": 0,
            "returned": 0,
            "hasMore": false,
            "cursor": "sample",
            "nextCursor": "sample"
          }
        },
        "spans": {
          "version": 0,
          "view": "safe",
          "rawAccessible": false,
          "items": [
            {
              "name": "sample",
              "kind": 0,
              "spanContext": {
                "traceId": "sample",
                "spanId": "sample",
                "isValid": false
              },
              "parentSpanId": "sample",
              "startTimeMs": 0,
              "endTimeMs": 0,
              "durationMs": 0,
              "attributes": {},
              "events": [
                {
                  "name": "sample",
                  "timestamp": 0,
                  "attributes": {}
                }
              ],
              "status": {
                "code": 0,
                "message": "sample"
              },
              "instrumentationScope": "sample"
            }
          ],
          "pageInfo": {
            "limit": 0,
            "returned": 0,
            "hasMore": false,
            "cursor": "sample",
            "nextCursor": "sample"
          }
        }
      }
    }
  },
  "telemetry.stream": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "version": 0,
      "capabilities": {
        "signals": {
          "events": false,
          "errors": false,
          "metrics": false,
          "traces": false
        },
        "encodings": {
          "json": false,
          "sse": false,
          "otlpJson": {
            "traces": false,
            "metrics": false,
            "logs": false
          }
        }
      },
      "view": "safe",
      "rawAccessible": false,
      "resumedFrom": "sample"
    }
  },
  "telemetry.traces.list": {
    "input": {
      "limit": 0,
      "since": 0,
      "until": 0,
      "domains": "sample",
      "types": "sample",
      "severity": "debug",
      "traceId": "sample",
      "sessionId": "sample",
      "turnId": "sample",
      "agentId": "sample",
      "taskId": "sample",
      "cursor": "sample",
      "view": "safe"
    },
    "output": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "items": [
        {
          "name": "sample",
          "kind": 0,
          "spanContext": {
            "traceId": "sample",
            "spanId": "sample",
            "isValid": false
          },
          "parentSpanId": "sample",
          "startTimeMs": 0,
          "endTimeMs": 0,
          "durationMs": 0,
          "attributes": {},
          "events": [
            {
              "name": "sample",
              "timestamp": 0,
              "attributes": {}
            }
          ],
          "status": {
            "code": 0,
            "message": "sample"
          },
          "instrumentationScope": "sample"
        }
      ],
      "pageInfo": {
        "limit": 0,
        "returned": 0,
        "hasMore": false,
        "cursor": "sample",
        "nextCursor": "sample"
      }
    }
  },
  "voice.providers.list": {
    "input": {},
    "output": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "capabilities": [
            "sample"
          ]
        }
      ]
    }
  },
  "voice.realtime.session": {
    "input": {
      "providerId": "sample",
      "modelId": "sample",
      "voiceId": "sample",
      "inputFormat": "sample",
      "outputFormat": "sample",
      "instructions": "sample",
      "metadata": {}
    },
    "output": {
      "providerId": "sample",
      "sessionId": "sample",
      "transport": "sample",
      "url": "sample",
      "expiresAt": 0,
      "headers": {},
      "metadata": {}
    }
  },
  "voice.status": {
    "input": {},
    "output": {
      "enabled": false,
      "providerCount": 0,
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "state": "sample",
          "capabilities": [
            "sample"
          ],
          "configured": false,
          "detail": "sample",
          "metadata": {}
        }
      ],
      "note": "sample"
    }
  },
  "voice.stt": {
    "input": {
      "providerId": "sample",
      "audio": {
        "mimeType": "sample",
        "format": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "sampleRateHz": 0,
        "durationMs": 0,
        "metadata": {}
      },
      "language": "sample",
      "modelId": "sample",
      "prompt": "sample",
      "metadata": {}
    },
    "output": {
      "providerId": "sample",
      "text": "sample",
      "language": "sample",
      "segments": [
        {
          "text": "sample",
          "startMs": 0,
          "endMs": 0,
          "confidence": 0
        }
      ],
      "metadata": {}
    }
  },
  "voice.tts": {
    "input": {
      "providerId": "sample",
      "text": "sample",
      "voiceId": "sample",
      "modelId": "sample",
      "format": "sample",
      "speed": 0,
      "metadata": {}
    },
    "output": {
      "providerId": "sample",
      "audio": {
        "mimeType": "sample",
        "format": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "sampleRateHz": 0,
        "durationMs": 0,
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "voice.tts.stream": {
    "input": {
      "providerId": "sample",
      "text": "sample",
      "voiceId": "sample",
      "modelId": "sample",
      "format": "sample",
      "speed": 0,
      "metadata": {}
    },
    "output": {
      "contentType": "sample",
      "providerId": "sample",
      "format": "sample"
    }
  },
  "voice.voices.list": {
    "input": {
      "providerId": "sample"
    },
    "output": {
      "voices": [
        {
          "id": "sample",
          "label": "sample",
          "locale": "sample",
          "gender": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "watchers.create": {
    "input": {
      "id": "sample",
      "label": "sample",
      "kind": "sample",
      "sourceId": "sample",
      "sourceKind": "sample",
      "intervalMs": 0,
      "metadata": {},
      "url": "sample",
      "method": "sample",
      "path": "sample",
      "endpoint": "sample",
      "address": "sample",
      "headers": {},
      "run": "sample"
    },
    "output": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.delete": {
    "input": {
      "watcherId": "sample"
    },
    "output": {
      "removed": false,
      "id": "sample"
    }
  },
  "watchers.list": {
    "input": {},
    "output": {
      "watchers": [
        {
          "id": "sample",
          "kind": "sample",
          "label": "sample",
          "state": "sample",
          "source": {
            "id": "sample",
            "kind": "sample",
            "label": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "intervalMs": 0,
          "lastHeartbeatAt": 0,
          "sourceLagMs": 0,
          "sourceStatus": "sample",
          "degradedReason": "sample",
          "lastCheckpoint": "sample",
          "lastError": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "watchers.run": {
    "input": {
      "watcherId": "sample"
    },
    "output": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.start": {
    "input": {
      "watcherId": "sample"
    },
    "output": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.stop": {
    "input": {
      "watcherId": "sample"
    },
    "output": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.update": {
    "input": {
      "watcherId": "sample",
      "label": "sample",
      "kind": "sample",
      "sourceId": "sample",
      "sourceKind": "sample",
      "enabled": false,
      "intervalMs": 0,
      "metadata": {},
      "url": "sample",
      "method": "sample",
      "path": "sample",
      "endpoint": "sample",
      "address": "sample",
      "headers": {},
      "run": "sample"
    },
    "output": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "web_search.providers.list": {
    "input": {},
    "output": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "capabilities": [
            "sample"
          ],
          "requiresAuth": false,
          "configured": false,
          "note": "sample"
        }
      ]
    }
  },
  "web_search.query": {
    "input": {
      "query": "sample",
      "providerId": "sample",
      "maxResults": 0,
      "verbosity": "sample",
      "region": "sample",
      "safeSearch": "sample",
      "timeRange": "sample",
      "includeInstantAnswer": false,
      "includeEvidence": false,
      "evidenceTopN": 0,
      "evidenceExtract": "sample"
    },
    "output": {
      "providerId": "sample",
      "providerLabel": "sample",
      "query": "sample",
      "verbosity": "sample",
      "results": [
        {
          "rank": 0,
          "url": "sample",
          "title": "sample",
          "snippet": "sample",
          "displayUrl": "sample",
          "domain": "sample",
          "type": "sample",
          "providerId": "sample",
          "metadata": {},
          "evidence": [
            {
              "url": "sample",
              "extract": "sample",
              "content": "sample",
              "tokensUsed": 0,
              "status": 0,
              "contentType": "sample",
              "truncated": false,
              "metadata": {}
            }
          ]
        }
      ],
      "instantAnswer": {
        "heading": "sample",
        "answer": "sample",
        "abstract": "sample",
        "source": "sample",
        "url": "sample",
        "image": "sample",
        "type": "sample",
        "related": [
          {
            "text": "sample",
            "url": "sample"
          }
        ],
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "workspaces.registrations.add": {
    "input": {
      "root": "sample",
      "label": "sample",
      "origin": "sample",
      "checkpointEligible": false
    },
    "output": {
      "workspace": {
        "root": "sample",
        "registeredAt": "sample",
        "label": "sample",
        "origin": "sample",
        "checkpointEligible": false
      },
      "alreadyRegistered": false
    }
  },
  "workspaces.registrations.list": {
    "input": {},
    "output": {
      "workspaces": [
        {
          "root": "sample",
          "registeredAt": "sample",
          "label": "sample",
          "origin": "sample",
          "checkpointEligible": false
        }
      ],
      "declines": [
        {
          "root": "sample",
          "declinedAt": "sample"
        }
      ]
    }
  },
  "workspaces.registrations.remove": {
    "input": {
      "root": "sample"
    },
    "output": {
      "root": "sample",
      "removed": false
    }
  },
  "workspaces.resolve": {
    "input": {
      "path": "sample",
      "mainWorktreeRoot": "sample"
    },
    "output": {
      "path": "sample",
      "status": "covered",
      "coveredBy": "sample",
      "declinedRoot": "sample",
      "viaWorktreeLink": false,
      "reason": "sample"
    }
  },
  "worktrees.discard": {
    "input": {
      "path": "sample"
    },
    "output": {
      "path": "sample",
      "ok": false,
      "branch": "sample",
      "preservedCommit": "sample",
      "discardedAt": 0,
      "detail": "sample"
    }
  },
  "worktrees.setup.run": {
    "input": {
      "path": "sample"
    },
    "output": {
      "path": "sample",
      "setup": {
        "state": "skipped",
        "startedAt": 0,
        "completedAt": 0,
        "steps": [
          {
            "kind": "command",
            "label": "sample",
            "ok": false,
            "exitCode": 0,
            "output": "sample"
          }
        ],
        "error": "sample"
      }
    }
  },
  "worktrees.snapshot": {
    "input": {},
    "output": {
      "summary": {
        "total": 0,
        "active": 0,
        "paused": 0,
        "kept": 0,
        "discard": 0,
        "pendingCleanup": 0,
        "sessionAttached": 0,
        "taskAttached": 0,
        "agentOwned": 0,
        "orchestratorOwned": 0,
        "manualOwned": 0
      },
      "records": [
        {
          "path": "sample",
          "kind": "agent",
          "state": "active",
          "ownerId": "sample",
          "sessionId": "sample",
          "taskId": "sample",
          "setup": {
            "state": "skipped",
            "startedAt": 0,
            "completedAt": 0,
            "steps": [
              {
                "kind": "command",
                "label": "sample",
                "ok": false,
                "exitCode": 0,
                "output": "sample"
              }
            ],
            "error": "sample"
          },
          "updatedAt": 0
        }
      ]
    }
  }
} as const;

/** Typed input for a method id, straight from the contract's IO ratchet. */
export type WebuiMethodInput<TMethodId extends OperatorMethodId> = OperatorMethodInput<TMethodId>;
/** Typed output for a method id, straight from the contract's IO ratchet. */
export type WebuiMethodOutput<TMethodId extends OperatorMethodId> = OperatorMethodOutput<TMethodId>;
