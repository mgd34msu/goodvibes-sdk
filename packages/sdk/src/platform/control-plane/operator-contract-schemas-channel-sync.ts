/**
 * operator-contract-schemas-channel-sync.ts
 *
 * The record shapes behind the eight `channels.inbox.list` /
 * `channels.routing.*` / `channels.drafts.*` verbs, the families that spent a
 * release cataloged with `invokable: false` because their advertised paths were
 * served by nothing, and are all served now.
 *
 * They sit here rather than inline in method-catalog-channels.ts for the reason
 * every other operator-contract-schemas-*.ts module exists: that file is the
 * catalog of a large verb family, and record definitions crowding the top of it
 * push the descriptors themselves past where anyone reads. Only
 * method-catalog-channels.ts imports these.
 */
import {
  STRING_SCHEMA,
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';

export const CHANNEL_INBOX_ITEM_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  from: STRING_SCHEMA,
  fromAddress: STRING_SCHEMA,
  subject: STRING_SCHEMA,
  bodyPreview: STRING_SCHEMA,
  receivedAt: NUMBER_SCHEMA,
  unread: BOOLEAN_SCHEMA,
  routeId: STRING_SCHEMA,
  threadId: STRING_SCHEMA,
  attachmentCount: NUMBER_SCHEMA,
  // Triage overlay. A host that runs an inbound triage pass (the daemon does)
  // scores each item as it is persisted and returns the score alongside it.
  // Declared here because it is SERVED, an item field a client receives and
  // the schema does not name is the contract lying by omission.
  triageScore: NUMBER_SCHEMA,
  triageLabel: STRING_SCHEMA,
  triageTags: arraySchema(STRING_SCHEMA),
}, ['id', 'provider', 'kind', 'from', 'bodyPreview', 'receivedAt', 'unread']);

/**
 * One provider's standing in the inbox answer.
 *
 * This exists so a short list is never ambiguous. Zero Slack items can mean
 * "nothing arrived", "no bot token was ever configured", or "Slack refused the
 * last four polls", three different things a client must be able to tell
 * apart, and which an items array alone cannot express. Every provider the host
 * knows about appears here on every call, including the ones that contributed
 * nothing.
 *
 * `state` is one of:
 *   `ready`       , synced, and this provider has items in the answer's window.
 *   `empty`       , synced, and it genuinely has nothing.
 *   `unconfigured`, no credential for it, so it was never asked. Not an error.
 *   `error`       , configured, asked, and the last attempt failed. `error`
 *                    carries what went wrong; this provider's items are MISSING
 *                    from the list, and the top-level `partial` flag says so.
 *   `pending`     , known but not yet synced once (a host that has just
 *                    started, or one whose fetching is another node's job).
 */
export const CHANNEL_INBOX_PROVIDER_STATUS_SCHEMA = objectSchema({
  provider: STRING_SCHEMA,
  state: STRING_SCHEMA,
  /** Items this provider contributed to the page being returned. */
  itemCount: NUMBER_SCHEMA,
  /** Items this provider holds in the host's synced mirror, ignoring the page. */
  storedCount: NUMBER_SCHEMA,
  /** Whether a credential resolved. Absent when the host has not looked yet. */
  configured: BOOLEAN_SCHEMA,
  /** Unix ms of the last completed sync attempt, successful or not. */
  lastSyncAt: NUMBER_SCHEMA,
  /** Whether THIS host is the one currently fetching this provider. */
  syncing: BOOLEAN_SCHEMA,
  /** Present when state is `error`. */
  error: STRING_SCHEMA,
}, ['provider', 'state', 'itemCount', 'storedCount']);

export const CHANNEL_ROUTING_RULE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  createdAt: STRING_SCHEMA,
  updatedAt: STRING_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  profileId: STRING_SCHEMA,
  label: STRING_SCHEMA,
}, ['id', 'createdAt', 'updatedAt', 'surfaceKind', 'profileId']);

export const CHANNEL_DRAFT_PROPERTIES = {
  version: NUMBER_SCHEMA,
  id: STRING_SCHEMA,
  createdAt: STRING_SCHEMA,
  updatedAt: STRING_SCHEMA,
  status: STRING_SCHEMA,
  title: STRING_SCHEMA,
  message: STRING_SCHEMA,
  channel: STRING_SCHEMA,
  route: STRING_SCHEMA,
  webhook: STRING_SCHEMA,
  link: STRING_SCHEMA,
  tags: arraySchema(STRING_SCHEMA),
  sentResponseId: STRING_SCHEMA,
  sendError: STRING_SCHEMA,
} as const;

export const CHANNEL_DRAFT_REQUIRED = ['version', 'id', 'createdAt', 'updatedAt', 'status', 'message'] as const;

export const CHANNEL_DRAFT_SCHEMA = objectSchema({ ...CHANNEL_DRAFT_PROPERTIES }, [...CHANNEL_DRAFT_REQUIRED]);

export const CHANNEL_DRAFT_GET_OUTPUT_SCHEMA = objectSchema(
  { ...CHANNEL_DRAFT_PROPERTIES, notFound: BOOLEAN_SCHEMA },
  [],
  { additionalProperties: true },
);