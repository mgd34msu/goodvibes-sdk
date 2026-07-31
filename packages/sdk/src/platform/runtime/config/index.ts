/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * runtime/config — the bridge from in-process config changes to the runtime
 * event bus `config` domain, so a client whose settings live in the daemon gets
 * live change notices instead of polling. See ./emit-bridge.ts.
 */

export {
  attachConfigEmitBridge,
  listWatchableConfigPaths,
  toConfigEventValue,
} from './emit-bridge.js';
export type { ConfigChangeSource, ConfigEmitBridgeDeps } from './emit-bridge.js';
