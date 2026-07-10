/**
 * conformance.ts — the descriptor/handler drift gate.
 *
 * The gate's implementation now lives once in the contracts package
 * (@pellux/goodvibes-contracts/testing) so every consuming front-end runs the
 * SAME kit rather than a divergent local copy. This module re-exports it so
 * @pellux/goodvibes-terminal-shell's public surface is unchanged — the single
 * source moved, the consumer contract did not.
 */
export {
  findMethodsMissingHandlers,
  assertEveryDescriptorHasHandler,
  type GatewayCatalogConformanceView,
  type ConformanceOptions,
} from '@pellux/goodvibes-contracts/testing';
