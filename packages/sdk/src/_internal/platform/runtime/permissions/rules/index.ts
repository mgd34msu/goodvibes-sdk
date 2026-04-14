/**
 * Runtime permissions policy rules barrel export.
 *
 * Re-exports all rule evaluator functions and result types.
 */

export { evaluatePrefixRule } from './prefix.js';
export type { PrefixRuleResult } from './prefix.js';

export { evaluateArgShapeRule } from './arg-shape.js';
export type { ArgShapeRuleResult } from './arg-shape.js';

export { evaluatePathScopeRule } from './path-scope.js';
export type { PathScopeRuleResult } from './path-scope.js';

export { evaluateNetworkScopeRule } from './network-scope.js';
export type { NetworkScopeRuleResult } from './network-scope.js';

export { evaluateModeConstraintRule } from './mode-constraint.js';
export type { ModeConstraintRuleResult } from './mode-constraint.js';
