export * from '@pellux/goodvibes-daemon-sdk';

// One-call daemon boot factory (thin composition over DaemonServer). Exposed on
// the public `@pellux/goodvibes-sdk/daemon` entry so embedders and tests can
// stand up a real daemon without hand-mirroring the construction graph.
export { bootDaemon, DaemonServer } from './platform/daemon/index.js';
export type { BootDaemonOptions, BootedDaemon } from './platform/daemon/index.js';
