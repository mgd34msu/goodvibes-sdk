/**
 * Ecosystem barrel — the curated catalog + capability-bundle distribution layer.
 *
 * Exposes the existing catalog/receipt/rollback machinery alongside the
 * capability-bundle format, SHA-256-pinned distribution, and the governed
 * marketplace index. This is the public entry point for building and installing
 * bundles under `@pellux/goodvibes-sdk/platform/runtime/ecosystem`.
 */

export * from './catalog.js';
export * from './recommendations.js';
export * from './bundle-manifest.js';
export * from './bundle-pin.js';
export * from './bundle-install.js';
export * from './marketplace-index.js';
