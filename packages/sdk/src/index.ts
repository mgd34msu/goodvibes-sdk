export type {
  GoodVibesRealtime,
  GoodVibesSdk,
  GoodVibesRealtimeOptions,
  GoodVibesSdkOptions,
  RuntimeEventRecord,
} from './client.js';
export { createGoodVibesSdk } from './client.js';
export type {
  BrowserTokenStoreOptions,
  GoodVibesAuthClient,
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
  GoodVibesTokenStore,
} from './auth.js';
export {
  createBrowserTokenStore,
  createGoodVibesAuthClient,
  createMemoryTokenStore,
} from './auth.js';
export type { BrowserGoodVibesSdkOptions } from './browser.js';
export { createBrowserGoodVibesSdk } from './browser.js';
export type { WebGoodVibesSdkOptions } from './web.js';
export { createWebGoodVibesSdk } from './web.js';
export type {
  GoodVibesCloudflareExecutionContext,
  GoodVibesCloudflareMessageBatch,
  GoodVibesCloudflareQueue,
  GoodVibesCloudflareQueueMessage,
  GoodVibesCloudflareQueuePayload,
  GoodVibesCloudflareWorker,
  GoodVibesCloudflareWorkerEnv,
  GoodVibesCloudflareWorkerOptions,
} from './workers.js';
export { createGoodVibesCloudflareWorker } from './workers.js';
export type {
  ReactNativeGoodVibesRealtime,
  ReactNativeGoodVibesSdk,
  ReactNativeGoodVibesSdkOptions,
} from './react-native.js';
export { createReactNativeGoodVibesSdk } from './react-native.js';
export type { ExpoGoodVibesSdkOptions } from './expo.js';
export { createExpoGoodVibesSdk } from './expo.js';
// The barrel re-exports below flatten symbols from their respective packages
// into the root SDK entrypoint. Each module is a single-concern passthrough
// that re-exports a transport, event, or contract layer.
//
// Why the indirection through named modules rather than direct `export *`?
// - Each intermediate module (observer, events, contracts, daemon, errors,
//   transport-*) is also a versioned, independently buildable sub-package.
//   The indirection lets us tree-shake at sub-package boundaries.
// - It makes source attribution explicit in the final bundle map.
//
// Collision risk: if two packages export the same name, TypeScript silently
// prefers the first binding. Keep all exported names unique across these modules.
export type { TokenStore, SessionManager, PermissionResolver, AutoRefreshCoordinator } from './client-auth/index.js';
export * from './observer/index.js';
export * from './events/index.js';
export * from './contracts.js';
export * from './daemon.js';
export * from './errors.js';
export * from './transport-core.js';
export * from './transport-direct.js';
export * from './transport-http.js';
export * from './transport-realtime.js';
export * from './operator.js';
export * from './peer.js';
