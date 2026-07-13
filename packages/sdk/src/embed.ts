/**
 * `@pellux/goodvibes-sdk/embed` — SDK Embedding API 1.0
 *
 * The supported, stability-marked surface for embedding a GoodVibes session in
 * another application: create a session against a workspace, send input, receive
 * typed events/results, inject a permission callback, and shut down. Everything
 * here is a curation of existing, already-shipped runtime machinery — the embed
 * surface adds no new engine; it names the minimal stable contract.
 *
 * ## Stability
 *
 * FROZEN at 1.0 (breaking changes are a semver-major and are gated by an
 * api-extractor report, `etc/goodvibes-sdk-embed.api.md`):
 *
 *   - {@link createEmbeddedSession} and the {@link EmbeddedSession} shape
 *     (`workspace`, `url`, `events`, `approvals`, `sessions`, `submit`, `stop`);
 *   - {@link EmbedSessionOptions}, {@link EmbeddedSessionInput};
 *   - the re-exported {@link bootDaemon} factory and its
 *     {@link BootDaemonOptions} / {@link BootedDaemon} contract;
 *   - the permission-callback contract
 *     ({@link PermissionRequestHandler} / {@link PermissionPromptRequest} /
 *     {@link PermissionPromptDecision});
 *   - the event subscription contract ({@link RuntimeEventBus} plus the
 *     {@link AnyRuntimeEvent} union and {@link RuntimeEventDomain}).
 *
 * INTERNAL (reachable through these types but NOT part of the frozen contract —
 * treat as advisory, may change in a minor): the full member surface of
 * {@link DaemonServer}, {@link ApprovalBroker}, and {@link SharedSessionBroker}
 * beyond the members named above; the concrete per-domain event payload fields.
 *
 * @packageDocumentation
 */

// ── The embedding facade ──────────────────────────────────────────────────────
export {
  createEmbeddedSession,
  type EmbeddedSession,
  type EmbedSessionOptions,
  type EmbeddedSessionInput,
} from './platform/embed/session.js';

// ── Session boot (the workspace-scoped daemon behind an embedded session) ─────
export { bootDaemon, DaemonServer } from './platform/daemon/index.js';
export type { BootDaemonOptions, BootedDaemon } from './platform/daemon/index.js';

// ── Permission callback contract ──────────────────────────────────────────────
export type {
  PermissionRequestHandler,
  PermissionPromptRequest,
  PermissionPromptDecision,
} from './platform/permissions/prompt.js';
export type { RememberTier, RememberTierOption } from './platform/permissions/approval-rules.js';

// ── Session + approval brokers (the submit + permission seams) ────────────────
export type { ApprovalBroker, SharedSessionBroker } from './platform/control-plane/index.js';
export type { SharedSessionSubmission, SubmitSharedSessionMessageInput } from './platform/control-plane/session-types.js';

// ── Typed event subscription ──────────────────────────────────────────────────
export { RuntimeEventBus } from './platform/runtime/events/index.js';
export type { AnyRuntimeEvent, RuntimeEventDomain } from './platform/runtime/events/index.js';
