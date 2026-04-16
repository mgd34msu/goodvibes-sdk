/**
 * @deprecated This module has been renamed. Import from component-contracts.js instead.
 *
 * This file is a backward-compatibility shim. All types and functions are
 * re-exported from component-contracts.ts under their original Panel* names.
 */

export type {
  ComponentThrottleStatus,
  ComponentHealthStatus,
  ComponentResourceContract,
  ComponentHealthState,
} from './component-contracts.js';

export type {
  PanelThrottleStatus,
  PanelHealthStatus,
  PanelResourceContract,
  PanelHealthState,
} from './component-contracts.js';

export {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialComponentHealthState,
  createInitialPanelHealthState,
} from './component-contracts.js';
