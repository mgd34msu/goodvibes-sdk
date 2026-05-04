/**
 * Shared companion-realtime re-export.
 *
 * NIT-07: `browser.ts`, `web.ts`, `expo.ts`, and `react-native.ts` each independently re-export `forSession`
 * from `./transport-realtime.js`. This shared internal module is the single source of truth
 * so that if `forSession`'s signature changes, only one import site needs updating.
 *
 * @internal Not a public entrypoint — import from `@pellux/goodvibes-sdk/browser`,
 * `@pellux/goodvibes-sdk/web`, `@pellux/goodvibes-sdk/expo`, or
 * `@pellux/goodvibes-sdk/react-native` instead.
 */
export { forSession } from './transport-realtime.js';
