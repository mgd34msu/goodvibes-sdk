/**
 * @pellux/goodvibes-terminal-shell
 *
 * Shared terminal-shell plumbing for GoodVibes daemon front-ends. This is the
 * single home for the runtime wiring that two front-ends must keep identical:
 * gateway verb-group composition, terminal enter/restore sequencing, and
 * render-tick coalescing. Each capability is a thin, dependency-injected wrapper
 * so a front-end's composition root becomes a few named calls into this package
 * instead of a hand-maintained copy that drifts.
 *
 * See ./conformance for the descriptor/handler gate a consumer runs against its
 * own composition in CI.
 */
export {
  attachWsOnlyGatewayVerbHandlers,
  createArchivableFleetRegistry,
  type GatewayVerbGroupDeps,
  type ProcessRegistryDeps,
  type ArchivableProcessRegistry,
} from './gateway-verbs.js';

export {
  TERMINAL_ESCAPES,
  createTerminalLifecycle,
  type TerminalEscapes,
  type TerminalSequenceSet,
  type TerminalLifecycleDeps,
  type TerminalLifecycle,
} from './terminal-lifecycle.js';

export {
  createRenderScheduler,
  type RenderScheduler,
} from './render-scheduler.js';

export {
  findMethodsMissingHandlers,
  assertEveryDescriptorHasHandler,
  type GatewayCatalogConformanceView,
  type ConformanceOptions,
} from './conformance.js';
