/**
 * @pellux/goodvibes-contracts/testing — the shipped conformance kit + mock-daemon
 * fixture generator, the single source consuming front-ends (terminal-shell, the
 * tui and agent forks, the webui, the Home Assistant fixtures) run instead of a
 * divergent local copy.
 *
 *   - conformance: assertEveryDescriptorHasHandler / findMethodsMissingHandlers —
 *     the descriptor/handler drift gate, run against a fully-composed catalog.
 *   - mock-daemon: buildMockDaemonResponses / buildMockDaemonFixtureMap /
 *     createMockDaemon / sampleFromSchema — schema-valid sample responses for
 *     every cataloged method, generated from the contract's own JSON Schemas so
 *     Playwright/HA mocks are generated rather than hand-written.
 */
export {
  assertEveryDescriptorHasHandler,
  findMethodsMissingHandlers,
  type GatewayCatalogConformanceView,
  type ConformanceOptions,
} from './conformance.js';
export {
  sampleFromSchema,
  buildMockDaemonResponses,
  buildMockDaemonFixtureMap,
  createMockDaemon,
  type MockDaemonResponse,
  type MockDaemonFixtureMap,
} from './mock-daemon.js';
