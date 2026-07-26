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
  'packages/sdk/src/platform/control-plane/method-catalog-runtime.ts': {
    ceiling: 807,
    justification: 'runtime-domain method descriptors (memory/mcp/voice/etc), crossed the cap with the memory.consolidation.receipts descriptor (typed receipts + pending-proposals output schema); next split: memory.* descriptors to a sibling file, mirroring method-catalog-fleet.ts',
  },
  'packages/sdk/src/platform/agents/wrfc-controller.ts': {
    ceiling: 2983,
    justification: 'pre-split monolith, shrink-only; +13 for the acceptance-checklist gate applied to BOTH review paths (the shared evaluateAcceptanceChecklistGate call, the unmet-items and missing-checklist critical-issue appends, and the pass-term additions in the main chain review and the compound-subtask review — gate mechanics live in completion-report.ts); +4 for stamping the gate-inclusive lastReviewVerdict onto the chain and subtask at their review gates, so wire consumers render the TRUE verdict rather than the reviewer claim',
  },
  // store.ts ~1.12k — knowledge store consolidated surface, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/store.ts': {
    ceiling: 1178,
    justification: 'knowledge store consolidated surface, pre-split, shrink-only; +8 for the MemoryGovernor cache-visibility surface: retainedEntryCount() plus the bounded listSourcesPage/listNodesPage paged reads (and their imports) that keep a single self-improvement run\'s distinct-space discovery from materializing the whole store at once; +50 for job-run retention + governor reclaim: the MAX_RETAINED_JOB_RUNS cap with pruneJobRuns (Map + sqlite rows, active runs protected, enforced at write and reload) and the iterateSources/iterateNodes single-pass cursors that replace the O(N²) offset re-scan',
  },
  // companion-chat-manager.ts 1204 — companion chat lifecycle manager, pre-split,
  // shrink-only. Re-justified 2026-07-07 (+145 over the original 1067) for the
  // server-side turn-control verbs: turns.cancel, queue-when-busy sends, and
  // messages.steer. The policy went to companion-chat-turn-control.ts (abort
  // scope, cancel finalization, reply-wait, queue types — ~290 lines); what
  // remains here is manager-owned state and wiring (per-session queue + active
  // turn slot, the start funnel, the steer/cancel public methods) that a
  // further split would scatter without shrinking the real surface.
  'packages/sdk/src/platform/companion/companion-chat-manager.ts': {
    ceiling: 1212,
    justification: 'companion chat lifecycle manager, pre-split, shrink-only; re-justified +145 for the turn-control verbs (cancel/queue/steer + partial-in-history) after extracting their policy to companion-chat-turn-control.ts',
  },
  // schema-domain-core.ts ~0.80k — core config defaults + per-key setting
  // definitions; crossed 800 with the behavior.compactionStrategy key.
  'packages/sdk/src/platform/config/schema-domain-core.ts': {
    ceiling: 881,
    justification: 'core config defaults + setting definitions, pre-split, shrink-only; +7 for the sandbox.judgmentAutoApprove config key (default in coreConfigDefaults + its ConfigSettingDefinition metadata entry) opting into auto-approve for the sandbox-model-judgment tier; +9 for the behavior.compactionStrategy config key (default in coreConfigDefaults + its ConfigSettingDefinition metadata entry) selecting structured vs distiller conversation compaction; +71 for promoting five flag-gated feature knobs to live config (defaults + ConfigSettingDefinition entries): provider.optimizerMode/optimizerPinnedModel (provider-optimizer routing mode), permissions.divergenceThreshold/maxDivergenceRecords (permission-divergence-dashboard enforce gate), tools.overflowSpillBackend (overflow-spill-backends target), and notifications.burstWindowMs/burstThreshold/burstCooldownMs (adaptive-notification-suppression burst detector)',
  },
  // schema-domain-runtime.ts ~0.83k — runtime config defaults + per-key setting
  // definitions; crossed 800 with the relay.* reachability keys.
  'packages/sdk/src/platform/config/schema-domain-runtime.ts': {
    ceiling: 888,
    justification: 'runtime config defaults + setting definitions; +22 for the three telemetry.decisionOtlp* config keys (decisionOtlpEnabled/decisionOtlpEndpoint/decisionOtlpSignal defaults in the telemetry defaults object plus their ConfigSettingDefinition metadata entries) backing decision-log-to-OTLP export; +30 for the relay.* reachability config (the relay defaults object plus the four relay.enabled/url/rendezvousId/label ConfigSettingDefinition entries); +7 for relay.requireStepUpForMutations (default + ConfigSettingDefinition entry) backing WebAuthn step-up on mutating relay calls; +29 for the runtime.toolBudget.maxMs/maxTokens/maxCostUsd config keys (defaults object + their ConfigSettingDefinition entries) backing default per-phase limits for runtime-tools-budget-enforcement',
  },
  // flags.ts ~0.83k — the internal capability registry: one entry per platform
  // capability, each carrying the full written description surfaces render.
  'packages/sdk/src/platform/runtime/feature-flags/flags.ts': {
    ceiling: 825,
    justification: 'internal capability registry; every entry carries the full written description surfaces render, so the file grows by roughly one paragraph per capability rather than by code. +22 for the paired-device-capabilities entry (the paired-phone camera/screen/location/clipboard/command family, its confirmation-and-grants posture, and the device.* keys that configure it)',
  },
  // schema-types.ts ~1.18k — config schema type surface, post-split, shrink-only
  'packages/sdk/src/platform/config/schema-types.ts': {
    ceiling: 1246,
    justification: 'config schema type surface, shrink-only. Split 2026-07-26 from 1399 lines: the '
      + 'listener/reachability interfaces (ControlPlaneConfig, HttpListenerRuntimeConfig, WebConfig, '
      + 'NetworkConfig, RelayConfig) moved to schema-types-network.ts and the platform-service '
      + 'interfaces (BatchConfig + its three modes, CloudflareConfig, TelemetryConfig, AtRestConfig) '
      + 'moved to schema-types-platform.ts, both re-exported here so import sites are unchanged — the '
      + 'same convention schema-types-surfaces.ts already used. What remains is the ConfigKey union and '
      + 'the ConfigValue mapped type, which stay inline because '
      + 'test/config-key-union-completeness.test.ts parses THIS file as the single source of the '
      + 'declared key set, plus the interfaces that have no other natural home. The ceiling was '
      + 'lowered from the old 1397 so new config keys cost a re-justification, which is the point of the '
      + 'ratchet. A second pass moved the daemon-service interfaces (NotificationsConfig, TtsConfig, '
      + 'AutomationConfig, WatchersConfig, ServiceConfig, RuntimeConfig) to schema-types-daemon.ts. The '
      + 'ceiling is deliberately left at 1246 while the file sits near 1175: it is never raised, but the '
      + 'slack is real headroom for config keys landing concurrently, so tightening it to the exact count '
      + 'would red-gate in-flight work rather than prevent drift.',
  },
  // orchestrator.ts ~1.08k — core orchestrator monolith, pre-split, shrink-only
  'packages/sdk/src/platform/core/orchestrator.ts': {
    ceiling: 1100,
    justification: 'core orchestrator monolith, pre-split, shrink-only; +5 for the compaction-strategy resolver wiring into checkContextWindowPreflight (import + getCompactionStrategy dep resolving behavior.compactionStrategy against the compaction-distiller-strategy flag; the resolver lives in conversation-compaction.ts); +15 for model-context-warning plumbing (pending-warning field, turn-loop note callback, preflight/post-turn dep wiring); +6 for replay deliver-once acknowledgment after injection; +11 for per-model tool-format telemetry (import + defensive active-model resolution + observeToolResults after the main-session tool loop)',
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
  // orchestrator-runner.ts ~0.97k — agent orchestrator runner, pre-split, shrink-only
  'packages/sdk/src/platform/agents/orchestrator-runner.ts': {
    ceiling: 918,
    justification: 'agent orchestrator runner; the context-window unit (the ActiveProviderRoute '
      + 'route-id parsing, providerQualifiedRouteLabel, resolveContextWindowModelDefinition, '
      + 'applyContextWindowAwareness, and the compaction-threshold constants + resolver) moved to '
      + 'orchestrator-runner-context-window.ts, with resolveContextWindowModelDefinition re-exported '
      + 'here so the agents/index.ts `export *` surface is unchanged — the same convention '
      + 'session-broker-intent.ts used. What remains is the turn loop itself. The ceiling is lowered '
      + 'to the exact post-split count (1028 -> 918): this is not a config-key file, so there is no '
      + 'concurrent-key argument for slack, and the next addition should cost a re-justification. '
      + 'Prior growth this entry recorded, retained as history: +9 for the model-context-warning compaction call after each chat response (logic lives in orchestrator-utils.ts); +6 for learning the observed context ceiling on provider too-long rejections; +9 for the background permission gate integration into the per-tool-call loop (gate call + denied/executed/threw branch, unified via a local recordResult closure; the gate logic itself lives in background-permission-gate.ts); +2 for the run context\'s at-rest journal redaction/retention policy field, threaded into the AgentSession construction (policy resolution + logic live in runtime/at-rest-persistence.ts); +3 for per-model tool-format telemetry (import + observeToolResults after the background-agent tool loop); +11 for the steer-wake resume seed (restore prior-context summary + inject the steer as a fresh user turn when a wedged agent is re-triggered); +5 for threading the agent cancellation signal into provider.chat (the mid-run abort seam) so a cancel/kill aborts the in-flight LLM call instead of only cooperatively at the next boundary; +25 for promoting the passive-injection + context-window-awareness knobs to live config: the optional configManager field on AgentOrchestratorRunContext + doc, the resolveContextCompactThreshold helper (agents.contextCompactThreshold vs the fallback constant) applied at the four threshold sites, and the budget-ceiling / relevance-floor / code-limit reads (agents.passiveInjection.*) in the per-turn injection block',
  },
  // service.ts (knowledge) ~0.92k — knowledge service facade, pre-split, shrink-only
  'packages/sdk/src/platform/knowledge/service.ts': {
    ceiling: 924,
    justification: 'knowledge service facade, pre-split, shrink-only; +5 for the MemoryGovernor admission gate: the KnowledgeServiceConfig.admitExpensiveWork hook, the requireAdmission helper, and its terms on runJob/ingestUrl/ingestArtifact (honest structured refusal at the critical memory tier)',
  },
  // runtime.ts (tools/exec) ~0.92k — exec tool runtime, pre-split, shrink-only
  'packages/sdk/src/platform/tools/exec/runtime.ts': {
    ceiling: 1027,
    justification: 'exec tool runtime, pre-split, shrink-only; +13 for the sandbox host-access escalation gate: the requestEscalation seam field on ExecSandboxRuntime plus the pre-spawn brokerSandboxEscalation call in runCommand that denies the command when the escalation is refused (the decision + broker logic live in sandbox.ts / sandbox-escalation.ts); +3 lines document the guard authority split (permission layer owns class risk, tool layer only the frozen catastrophic block); +30 for X: the credential-bearing env scrub — the scrub call + withheld-name computation + attach helper in runCommand and the scrub-config option/threading through the command dispatch chain (the scrub itself lives in credential-env.ts); +30 for the per-command exec sandbox — threading the sandbox runtime context through the command dispatch chain (executeResolvedCommands/executeResolvedCommand/runWithRetry/runCommand), the per-command plan resolution + bwrap argv prefix at the three foreground Bun.spawn sites, and the sandbox metadata attach in runCommand (the sandbox runner + plan + metadata helpers live in sandbox.ts); +35 for the PTY prompt-answer path — the interaction runtime option on createExecTool, threading it through the command dispatch chain, the shouldRunInteractive dispatch in runCommand, and the pty/prompt fields in formatResult (the PTY runner + detection + availability probing live in interactive.ts)',
  },
  // manager.ts (tools/agent) ~0.87k — agent tool manager, pre-split, shrink-only
  'packages/sdk/src/platform/tools/agent/manager.ts': {
    ceiling: 965,
    justification: 'agent tool manager, pre-split, shrink-only; +60 for steer-wake (the resumeSteer AgentRecord field + doc, the wakeWithSteer method that re-triggers a terminally-failed agent through the executor, and the transcript-tail summary helper it uses to restore honest prior context); +37 for the mid-run abort seam: the manager-owned per-agent AbortController map + doc, cancel() creating-then-aborting the controller so an in-flight provider call is interrupted (and a cancel requested before the runner reads the signal is not dropped), getCancellationSignal falling back to the owned controller (engine-registered external signal keeps precedence), and releaseCancellationSignal cleaning it up',
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
    ceiling: 1197,
    justification: 'runtime services composition root, pre-split, shrink-only; +13 for wiring the sandbox-escalation handler (import + buildSandboxEscalationHandler call bridging the exec sandbox to the approval broker + judgment tier, threaded into the AgentOrchestrator tool deps; the wiring + judgment provider live in permissions/sandbox-escalation-wiring.ts); +26 for constructing the background-agent PermissionManager (ask handler bridged to the shared approval broker with subagent attribution) and threading it into the AgentOrchestrator dependencies; +4 for wiring the MCP elicitation handler (import + setElicitationHandler bridging elicitation/create to the same approval broker); +13 for the context_accounting source holder (import, holder construction, threading it into the AgentOrchestrator tool deps, the RuntimeServices interface field, and the return-object entry); +5 for constructing the relay WebAuthn StepUpService (import + one-line construction, threading it into registerGatewayVerbGroups deps, the RuntimeServices interface field, and the return-object entry) shared by the stepup.* verbs and the relay gate verifier; +41 for wiring flag-gated feature knobs to live config at the composition root: the ApiTokenAuditor rotation-cadence/warning/managed reads (security.tokenAudit.*), the applyProviderOptimizerConfigMode helper applying provider.optimizerMode/optimizerPinnedModel, the OverflowHandler spillBackend read (tools.overflowSpillBackend), and the loadConfiguredPolicyBundle call (policy.bundleSource/bundlePath, logic in permissions/policy-config-loader.ts); +7 for wiring the live featureFlags config bridge (import + bindFeatureFlagConfigBridge call, guarded by the same options.featureFlags === undefined check as the boot loadFromConfig call, so config.set(\'featureFlags.<id>\', ...) reaches the manager without a restart — logic lives in feature-flags/config-bridge.ts); +9 for wiring the exec PTY prompt-answer handler (import + buildExecPromptAnswerHandler call bridging a command\'s pending terminal prompt to the approval broker, threaded into the AgentOrchestrator tool deps; the wiring lives in permissions/exec-prompt-wiring.ts); +7 for the observe-external-agents opt-in: the ObservedAgentSource import + construction (gated on options.observeExternalAgents so the generic factory never scans the host process table), its threading into the process-registry deps, and the RuntimeServicesOptions field doc (detection/liveness/steer logic all live in runtime/fleet/observed/*); +13 for the write-model residue fixes at the composition root: the full-roots startup sweep call (logDir/telemetryDir/homeDirectory so the activity-log, telemetry-ledger, and recovery-snapshot stores actually run) and the configManager.watchConfigFiles() live external-edit wiring; +1 for the power.keepAwake live-apply subscribeConfig line threaded into wireRuntimePower; +18 for the consolidation-receipt attach-notice sink (announcementStore hoisted above the scheduler, the onReceipt closure recording a per-run announce-once line when a pass merged/decayed/archived/proposed anything); +47 for the memory governance composition (a safety feature, default ON): the CacheRegistry + PauseController built early so scheduler gates can consult them, the two scheduler pause gates (code-index reindex isEnabled, memory-consolidation isIdle), the three semantic-service isBackgroundPaused hooks, the MemoryGovernor construction via wireDaemonMemoryGovernance threaded into registerGatewayVerbGroups for the ops.memory verb, and the three RuntimeServices interface members + return fields (governor/cacheRegistry/pauseController); +32 for managed local-voice provisioning: the ensureBuiltinVoiceProviders managedVoiceRoot wiring so a provisioned host resolves engines with zero config, and the voiceSetup service (status read + one-act install that provisions the piper engine + default voice and pre-configures the voice.local.* keys with user-set keys preserved) threaded into registerGatewayVerbGroups for the voice.local.status/install verbs; +22 for making the governor real: the late-bound admitExpensiveWork holder + closure the expensive entry points capture, its threading into the three semantic services and two knowledge services, the admission terms on the consolidation/code-index gates, and the real cache adapters + graceful tripwire shutdown hook handed to wireDaemonMemoryGovernance; +12 for ownership-aware voice preconfigure (install-stamp read/persist around preconfigureLocalVoiceKeys and the post-install breaker reset via the local provider); +3 for threading provisioned STT values into the ownership-aware preconfigure; +13 for single-flighting voice.local.install (runVoiceInstall via utils/single-flight) and its critical-tier admission term; +2 for the admitExpensiveWork terms on the agent knowledge and home-graph service constructions; +44 for constructing the trigger family at the composition root: the TriggerManager + hosts imports, the RuntimeServices interface member + doc and its return-object entry, the triggerSupervisor line threading it into the process registry, and the construction itself — whose config is a CLOSURE over configManager rather than a snapshot, so watchers.triggers.enabled is a genuine runtime toggle instead of a restart-only one, and whose process host is ProcessManager-backed so a supervised on-exit child inherits the same credential-env scrub, live output collection and SIGTERM/SIGKILL watchdog as any other background command (supervision lives in ../triggers/, effects in ../triggers/hosts.ts); +5 for the doc explaining why the field is OPTIONAL rather than required — hosts hand-compose RuntimeServices, and a required field made every such host throw on daemon shutdown',
  },
  // scheduler.ts ~0.85k — scheduler core, pre-split, shrink-only
  'packages/sdk/src/platform/scheduler/scheduler.ts': {
    ceiling: 846,
    justification: 'scheduler core, pre-split, shrink-only',
  },
  // router.ts (daemon/http) ~0.85k — daemon HTTP router, pre-split, shrink-only
  'packages/sdk/src/platform/daemon/http/router.ts': {
    ceiling: 854,
    justification: 'daemon HTTP router, pre-split, shrink-only; +5 for the in-process sessionBroker adapter (getInputsSince/markInputDelivered surface-collection delegations); +1 for the detachParticipant adapter delegation; the opt-in same-origin bundle-serving + cross-origin (CORS) seam lives in http/webui-serving.ts, with only the pre-auth dispatch split retained here; +3 for the memoryConsolidation context member + pass-through backing the consolidation-receipts route; +5 for announcing the client build floor on /status (the import plus two option lines handed to createDaemonControlRouteHandlers, and the two-line note explaining why). It belongs at this composition site and nowhere else: /status is the one call every attached client already makes on a timer, so the floor reaches a stale terminal UI or agent within one probe interval without a new endpoint or a contract change. The value, the comparison, and the header name live in control-plane/client-compatibility.ts; the response header itself is set in daemon-sdk/control-routes.ts',
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
    ceiling: 910,
    justification: 'daemon facade, pre-split, shrink-only; +9 for the approvals broker accessor (embedder/test seam) + doc; +18 for the outbound relay reachability boot seam (start/stop lifecycle wiring + surface accessor; the heavy composition lives in ../relay/daemon-wiring.ts); +24 for two in-process embedder seams the ACP adapter needs: cancelAgent (a real cancellation of a running agent) + registerMcpServer (connect a client-declared MCP server into the live registry) with docs; +6 for releasing sleep-inhibitor holds on a real (non-restart) stop — an exited daemon must never leave systemd-inhibit children blocking host sleep; +3 for surface ingress start/stop wiring — Telegram delivers nothing until the daemon calls setWebhook or getUpdates, so the route alone received no messages at all; the supervisor itself lives in ../channels/telegram/ingress.ts; +15 for owning the trigger family\'s daemon lifecycle: the triggerManager field + assignment, the start() call that recovers persisted triggers and arms the supervision tick, the shutdown() call on stop, and the `triggers` accessor (mirroring the `memory` accessor) an embedder or proof run needs. This wiring is the point of the subsystem: a trigger nothing starts is indistinguishable from a trigger that does not exist, and on-exit triggers are daemon-owned precisely so a six-hour build does not hold an agent turn open; +3 for making that dependency OPTIONAL after it broke every consumer that hand-composes RuntimeServices (goodvibes-agent builds its own object literal, so a required field turned \'this host has no trigger family\' into a TypeError on every daemon shutdown): the optional-chained start()/shutdown() calls and the absent-manager branch. Absence must mean no triggers, never a crash',
  },
  // gateway.ts (control-plane) ~0.83k — control-plane gateway, pre-split, shrink-only
  'packages/sdk/src/platform/control-plane/gateway.ts': {
    ceiling: 842,
    justification: 'control-plane gateway, pre-split, shrink-only; +16 for the MemoryGovernor cache surface: retainedEventCount() and trimRetainedEvents(level) — a REAL reclaim over the replay ring + surface-message buffer (floor halves the retained history, flush clears it; replay degrades honestly to an empty backlog)',
  },
  // runtime-session-routes.ts ~0.87k — daemon runtime-session route surface, pre-split, shrink-only
  'packages/daemon-sdk/src/runtime-session-routes.ts': {
    ceiling: 893,
    justification: 'daemon runtime-session route surface, pre-split, shrink-only; +55 for the surface-collection wire (queued-for-surface response handling, sessions.inputs.deliver route + handler, sessions.inputs.list state/since cursor); +20 for the sessions.detach handler (surfaceId 400 guard + broker delegation)',
  },
  // registry.ts (runtime/fleet) ~0.81k — runtime fleet registry, pre-split, shrink-only
  'packages/sdk/src/platform/runtime/fleet/registry.ts': {
    ceiling: 876,
    justification: 'runtime fleet registry, pre-split, shrink-only; +12 for steer-wake: a wedged (failed) agent whose loop has exited is re-triggered via agentManager.wakeWithSteer instead of an honest refusal (the branch + comment in steer()\'s agent case); +19 for the headline + stall-tell read-model projections: the stallTellMs dep, the HeadlineTable side-table construction, and the post-assemble node mapping that attaches headline/stall to every snapshot (derivation + anti-feed contract live in headlines.ts); +5 for the observed-external fold: the optional observedAgents dep, the assemble() fold of read-only observed rows, and the steer() dispatch case to the foreign session\'s own channel (detection/liveness/steer logic all live in observed/* and adapters/observed.ts); +34 for folding in the trigger family (stream watchers, condition checks, on-exit process triggers): the optional triggerSupervisor dep + doc, the assemble() loop that adapts its records, and the three control-verb branches (kill/interrupt/resume) that route on isWatcherTriggerRaw — the trigger family and the workflow tool BOTH publish nodes under the \'trigger\' kind, so every control path has to ask the raw payload which manager owns the node rather than dispatching on kind alone, or a kill would silently no-op and leave a supervised child process running (adapter + discriminator live in adapters/watcher-trigger.ts, supervision in ../../triggers/)',
  },
  // registry.ts (providers) ~0.82k — provider registry, split candidate
  'packages/sdk/src/platform/providers/registry.ts': {
    ceiling: 822,
    justification: 'provider registry crossed the cap with the context-window knowledge surface (user override + observed-limit delegates to ContextWindowOverrideStore, which owns the logic); model-listing vs provider-lifecycle split is the natural next cut',
  },
  // session-broker.ts (control-plane) ~0.84k — control-plane session broker, post-split, shrink-only
  'packages/sdk/src/platform/control-plane/session-broker.ts': {
    ceiling: 844,
    justification: 'control-plane session broker; handleIntent (the submit/steer/follow-up dispatch body) moved to the free function handleSharedSessionIntent in session-broker-intent.ts, following the deps-object convention of session-broker-gc.ts/session-broker-inputs.ts/session-broker-sessions.ts; the class keeps a thin delegating handleIntent wrapper; ceiling lowered to the post-split line count',
  },
};
