/**
 * Compile-time pin: a plain `ConfigManager` satisfies the conversation gate's
 * config reader, from a CONSUMER's vantage point.
 *
 * This is the shape of the wiring both consumers do — `goodvibes-tui` and
 * `goodvibes-agent` construct a `SharedSessionBroker` and hand it their
 * `ConfigManager` as `conversationGateConfig`, which is what makes the daemon
 * honor `conversationGate.mode` and `gatedSurfaces` on the live-agent handover
 * path.
 *
 * It used not to compile. `ConversationGateConfigReader.getCategory` was typed
 * with the literal `'conversationGate'`, and `ConfigManager.getCategory` is
 * generic over `keyof GoodVibesConfig` — a union `conversationGate` only joins
 * through a module augmentation in config/schema-domain-conversation-gate.ts.
 * Inside the SDK's own program that augmentation is always loaded, so the SDK's
 * composition root compiled and the defect was invisible here. A consumer's
 * program loads only the declarations its own imports reach, so there the
 * literal was not assignable and passing a ConfigManager was rejected:
 *
 *   Type '"conversationGate"' is not assignable to type 'keyof GoodVibesConfig'
 *
 * Everything below resolves through the PACKAGE NAME, not a relative path, so
 * this file's program is built the way a consumer's is — which is the only
 * vantage point from which that failure is visible.
 *
 * Checked by `bun run types:check`.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConversationGateConfigReader } from '@pellux/goodvibes-sdk/platform/agents';

// The assignment under test: a ConfigManager IS a gate config reader.
declare const configManager: ConfigManager;
export const reader: ConversationGateConfigReader = configManager;

// And the same value in the position the consumers actually use it — the
// broker's optional `conversationGateConfig`. Typed against the constructor's
// own parameter so a rename or a narrowing of that field fails here too.
type SharedSessionBrokerConfig = ConstructorParameters<
  typeof import('@pellux/goodvibes-sdk/platform/control-plane').SharedSessionBroker
>[0];

export const brokerGateConfig: SharedSessionBrokerConfig['conversationGateConfig'] = configManager;
