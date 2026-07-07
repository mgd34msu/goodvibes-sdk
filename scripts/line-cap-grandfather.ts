// line-cap-grandfather.ts
//
// Ratchet list for the 800-line source-file cap enforced by
// check-line-cap.ts.
//
// Every file below already exceeded the cap when this gate was introduced
// (2026-07, measured against packages/*/src at commit ddadc094). Each entry
// records the file's CURRENT line count as its own individual ceiling — a
// grandfathered file may shrink but must NEVER grow past its recorded
// ceiling. When a file's line count later drops under 800, check-line-cap.ts
// fails the build until its entry is removed from this list (a "stale
// entry" — the ratchet must not silently outlive the violation it recorded).
//
// New files get no entry here and are held to the hard 800-line cap with
// zero tolerance.
//
// To add an entry: record the file's exact current line count as `ceiling`
// and a one-line justification for why the split hasn't happened yet.

import type { GrandfatherEntry } from './line-cap-rule.ts';

export const LINE_CAP_GRANDFATHER: Readonly<Record<string, GrandfatherEntry>> = {
  // wrfc-controller.ts ~2.97k — pre-split monolith, shrink-only
  'packages/sdk/src/platform/agents/wrfc-controller.ts': {
    ceiling: 2966,
    justification: 'pre-split monolith, shrink-only',
  },
  // store.ts ~1.12k — knowledge store consolidated surface, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/store.ts': {
    ceiling: 1120,
    justification: 'knowledge store consolidated surface, pre-split, shrink-only',
  },
  // companion-chat-manager.ts ~1.07k — companion chat lifecycle manager, pre-split, shrink-only
  'packages/sdk/src/platform/companion/companion-chat-manager.ts': {
    ceiling: 1067,
    justification: 'companion chat lifecycle manager, pre-split, shrink-only',
  },
  // code-index-store.ts 806 — the sqlite-vec platform-limit classification (capability
  // limit reported as reason, not error) added 6 lines over the cap; shrink-only.
  'packages/sdk/src/platform/state/code-index-store.ts': {
    ceiling: 806,
    justification: 'code index store, pre-split, shrink-only; +6 for the sqlite-vec platform-capability-limit classification (platformLimitReason field + branch)',
  },
  // schema-types.ts ~1.07k — config schema type surface, pre-split, shrink-only
  'packages/sdk/src/platform/config/schema-types.ts': {
    ceiling: 1079,
    justification: 'config schema type surface, pre-split, shrink-only; +2 for the daemon.embedInProcess config key (ConfigKey union + ConfigValue mapped-type entry); +13 for the four opt-in web UI serving / cross-origin config keys (controlPlane.webui.serve/bundleDir + controlPlane.cors.enabled/allowedOrigins: two nested interface members plus their ConfigKey union and ConfigValue mapped-type entries)',
  },
  // orchestrator.ts ~1.06k — core orchestrator monolith, pre-split, shrink-only
  'packages/sdk/src/platform/core/orchestrator.ts': {
    ceiling: 1063,
    justification: 'core orchestrator monolith, pre-split, shrink-only',
  },
  // enrichment.ts ~1.00k — semantic enrichment pipeline, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/semantic/enrichment.ts': {
    ceiling: 1005,
    justification: 'semantic enrichment pipeline, pre-split, shrink-only',
  },
  // knowledge-routes.ts ~1.00k — daemon knowledge route surface, pre-split, shrink-only
  'packages/daemon-sdk/src/knowledge-routes.ts': {
    ceiling: 1002,
    justification: 'daemon knowledge route surface, pre-split, shrink-only',
  },
  // service.ts (project-planning) ~1.00k — project-planning service, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/project-planning/service.ts': {
    ceiling: 1001,
    justification: 'project-planning service, pre-split, shrink-only',
  },
  // generated-pages.ts (home-graph) ~1.00k — home-graph page template builder, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/home-graph/generated-pages.ts': {
    ceiling: 996,
    justification: 'home-graph page template builder, pre-split, shrink-only',
  },
  // runtime-events.ts ~0.97k — realtime runtime-event surface, pre-split, shrink-only
  'packages/transport-realtime/src/runtime-events.ts': {
    ceiling: 969,
    justification: 'realtime runtime-event surface, pre-split, shrink-only',
  },
  // method-catalog-knowledge.ts ~0.96k — control-plane knowledge method catalog, pre-split, shrink-only
  'packages/sdk/src/platform/control-plane/method-catalog-knowledge.ts': {
    ceiling: 962,
    justification: 'control-plane knowledge method catalog, pre-split, shrink-only',
  },
  // otlp-protobuf.ts ~0.96k — OTLP protobuf wire encoding, pre-split, shrink-only
  'packages/daemon-sdk/src/otlp-protobuf.ts': {
    ceiling: 960,
    justification: 'OTLP protobuf wire encoding, pre-split, shrink-only',
  },
  // orchestrator-runner.ts ~0.96k — agent orchestrator runner, pre-split, shrink-only
  'packages/sdk/src/platform/agents/orchestrator-runner.ts': {
    ceiling: 958,
    justification: 'agent orchestrator runner, pre-split, shrink-only',
  },
  // service.ts (knowledge) ~0.92k — knowledge service facade, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/service.ts': {
    ceiling: 919,
    justification: 'knowledge service facade, pre-split, shrink-only',
  },
  // runtime.ts (tools/exec) ~0.92k — exec tool runtime, pre-split, shrink-only
  'packages/sdk/src/platform/tools/exec/runtime.ts': {
    ceiling: 916,
    justification: 'exec tool runtime, pre-split, shrink-only',
  },
  // manager.ts (tools/agent) ~0.87k — agent tool manager, pre-split, shrink-only
  'packages/sdk/src/platform/tools/agent/manager.ts': {
    ceiling: 868,
    justification: 'agent tool manager, pre-split, shrink-only',
  },
  // projections.ts (knowledge) ~0.87k — knowledge projections, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/projections.ts': {
    ceiling: 868,
    justification: 'knowledge projections, pre-split, shrink-only',
  },
  // secret-refs.ts ~0.87k — config secret-reference resolution, pre-split, shrink-only
  'packages/sdk/src/platform/config/secret-refs.ts': {
    ceiling: 866,
    justification: 'config secret-reference resolution, pre-split, shrink-only',
  },
  // services.ts (runtime) ~0.86k — runtime services composition root, pre-split, shrink-only
  'packages/sdk/src/platform/runtime/services.ts': {
    ceiling: 858,
    justification: 'runtime services composition root, pre-split, shrink-only',
  },
  // scheduler.ts ~0.85k — scheduler core, pre-split, shrink-only
  'packages/sdk/src/platform/scheduler/scheduler.ts': {
    ceiling: 846,
    justification: 'scheduler core, pre-split, shrink-only',
  },
  // router.ts (daemon/http) ~0.85k — daemon HTTP router, pre-split, shrink-only
  'packages/sdk/src/platform/daemon/http/router.ts': {
    ceiling: 846,
    justification: 'daemon HTTP router, pre-split, shrink-only; +5 for the in-process sessionBroker adapter (getInputsSince/markInputDelivered surface-collection delegations); +1 for the detachParticipant adapter delegation; the opt-in same-origin bundle-serving + cross-origin (CORS) seam lives in http/webui-serving.ts, with only the pre-auth dispatch split retained here',
  },
  // index.ts (tools/state) ~0.84k — tools state store, pre-split, shrink-only
  'packages/sdk/src/platform/tools/state/index.ts': {
    ceiling: 838,
    justification: 'tools state store, pre-split, shrink-only',
  },
  // scanner.ts (discovery) ~0.84k — discovery scanner, pre-split, shrink-only
  'packages/sdk/src/platform/discovery/scanner.ts': {
    ceiling: 837,
    justification: 'discovery scanner, pre-split, shrink-only',
  },
  // facade.ts (daemon) ~0.83k — daemon facade, pre-split, shrink-only
  'packages/sdk/src/platform/daemon/facade.ts': {
    ceiling: 835,
    justification: 'daemon facade, pre-split, shrink-only; +9 for the approvals broker accessor (embedder/test seam) + doc',
  },
  // gateway.ts (control-plane) ~0.83k — control-plane gateway, pre-split, shrink-only
  'packages/sdk/src/platform/control-plane/gateway.ts': {
    ceiling: 826,
    justification: 'control-plane gateway, pre-split, shrink-only',
  },
  // runtime-session-routes.ts ~0.87k — daemon runtime-session route surface, pre-split, shrink-only
  'packages/daemon-sdk/src/runtime-session-routes.ts': {
    ceiling: 893,
    justification: 'daemon runtime-session route surface, pre-split, shrink-only; +55 for the surface-collection wire (queued-for-surface response handling, sessions.inputs.deliver route + handler, sessions.inputs.list state/since cursor); +20 for the sessions.detach handler (surfaceId 400 guard + broker delegation)',
  },
  // registry.ts (runtime/fleet) ~0.81k — runtime fleet registry, pre-split, shrink-only
  'packages/sdk/src/platform/runtime/fleet/registry.ts': {
    ceiling: 806,
    justification: 'runtime fleet registry, pre-split, shrink-only',
  },
  // session-broker.ts (control-plane) ~0.88k — control-plane session broker, pre-split, shrink-only
  'packages/sdk/src/platform/control-plane/session-broker.ts': {
    ceiling: 905,
    justification: 'control-plane session broker, pre-split, shrink-only; +75 for surface-managed session routing (surface-managed marking on register, steer/follow-up surface-routing branch in handleIntent, getInputsSince/markInputDelivered surface-collection delegations); +25 for detachParticipant (idempotent detach != close != kill) — pruning logic extracted to detachSharedSessionParticipant in session-broker-sessions.ts; handleIntent remains a split candidate',
  },
};
