/**
 * Shared companion-realtime re-export.
 *
 * NIT-07: `browser.ts`, `web.ts`, and `expo.ts` each independently re-export `forSession`
 * from `./transport-realtime.js`. This shared internal module is the single source of truth
 * so that if `forSession`'s signature changes, only one import site needs updating.
 *
 * @internal Not a public entrypoint — import from `@pellux/goodvibes-sdk/browser`,
 * `@pellux/goodvibes-sdk/web`, or `@pellux/goodvibes-sdk/expo` instead.
 */
export { forSession } from './transport-realtime.js';
