/**
 * config-read.ts, read `cluster.*` out of a ConfigManager, from inside the SDK.
 *
 * Why this exists rather than every caller doing `getCategory('cluster')`:
 * the config schema is assembled from domain modules that each declare their
 * slice of `GoodVibesConfig` with `declare module`. Those augmentations are in
 * scope while the SDK itself compiles, but they do NOT survive into the
 * published type surface, a consumer importing `ConfigManager` from
 * `@pellux/goodvibes-sdk/platform/config` finds that `getCategory('cluster')`
 * does not typecheck, and neither does `getCategory('fleet')` or
 * `getCategory('conversationGate')`. That is a pre-existing gap in how the
 * schema domains are published, not something the cluster domain introduced.
 *
 * Rather than have every consumer cast around it, the read happens HERE, where
 * the augmentation is genuinely in scope, and callers receive resolved
 * `ClusterSettings`, a plain, fully-typed value with no augmentation
 * dependency at all.
 */
import type { ConfigManager } from '../config/manager.js';
import { resolveClusterSettings } from './settings.js';
import type { ClusterSettings } from './types.js';

/**
 * Resolved cluster settings for this host.
 *
 * A host whose config predates the cluster domain simply gets the defaults:
 * an absent section is not a misconfiguration, and refusing to start over one
 * would take inbound messaging down for an install that never opted in.
 */
export function readClusterSettings(configManager: Pick<ConfigManager, 'getCategory'>): ClusterSettings {
  try {
    return resolveClusterSettings(configManager.getCategory('cluster'));
  } catch {
    return resolveClusterSettings(undefined);
  }
}
