/**
 * channel-sync/registry.ts, the routing table and the draft mirror.
 *
 * `assign` is an upsert keyed on (surfaceKind, channelId?): routing the same
 * channel again replaces the rule rather than accumulating rows that disagree
 * about where one channel goes. `saveDraft` is an upsert keyed on the draft's
 * own id, and reports whether it created one, because the composing surface
 * needs to tell "my draft synced" from "someone else's draft arrived".
 *
 * Whole-store writes go through a StoreWriteQueue for the same reason the
 * channel-profile registry's do: the store replaces the file atomically but
 * says nothing about ORDER, and an unordered write can land a delete's
 * predecessor after it and put a removed record back on disk.
 */
import { StoreWriteQueue } from '../state/store-write-queue.js';
import type { ChannelSyncStore, ChannelSyncTables } from './store.js';
import {
  CHANNEL_DRAFT_STATUSES,
  ChannelSyncError,
  channelRoutingRuleId,
  looksLikeLiveWebhook,
  type ChannelDraft,
  type ChannelDraftStatus,
  type ChannelRoutingRule,
} from './types.js';

export interface AssignChannelRoutingInput {
  readonly surfaceKind: string;
  readonly profileId: string;
  readonly channelId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export interface ListChannelRoutingOptions {
  readonly surfaceKind?: string | undefined;
  readonly profileId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListChannelDraftsOptions {
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ChannelSyncError(`${field} is required`, 'INVALID_ARGUMENT', field);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ChannelSyncError(`${field} must be a string`, 'INVALID_ARGUMENT', field);
  return value.trim() || undefined;
}

function requireStatus(value: unknown): ChannelDraftStatus {
  const status = requireString(value, 'status');
  if (!(CHANNEL_DRAFT_STATUSES as readonly string[]).includes(status)) {
    throw new ChannelSyncError(
      `status must be one of ${CHANNEL_DRAFT_STATUSES.join(', ')}`,
      'INVALID_ARGUMENT',
      'status',
    );
  }
  return status as ChannelDraftStatus;
}

/** A bound on how many rows one read returns. Absent or absurd ⇒ everything. */
function applyLimit<T>(rows: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return [...rows];
  return rows.slice(0, Math.floor(limit));
}

export class ChannelSyncRegistry {
  private tables: ChannelSyncTables | null = null;
  private readonly writes = new StoreWriteQueue();
  private readonly now: () => number;

  constructor(private readonly store: ChannelSyncStore, options: { now?: () => number } = {}) {
    this.now = options.now ?? ((): number => Date.now());
  }

  private async load(): Promise<ChannelSyncTables> {
    this.tables ??= await this.store.load();
    return this.tables;
  }

  private async persist(tables: ChannelSyncTables): Promise<void> {
    const snapshot: ChannelSyncTables = { routes: [...tables.routes], drafts: [...tables.drafts] };
    await this.writes.run(() => this.store.save(snapshot));
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  async listRoutes(options: ListChannelRoutingOptions = {}): Promise<{ routes: ChannelRoutingRule[]; total: number }> {
    const tables = await this.load();
    const surfaceKind = options.surfaceKind?.trim().toLowerCase();
    const profileId = options.profileId?.trim();
    const matched = tables.routes.filter((rule) =>
      (!surfaceKind || rule.surfaceKind === surfaceKind)
      && (!profileId || rule.profileId === profileId));
    // `total` is what MATCHED, not what was returned: a caller that passed a
    // limit needs to know there is more, and reporting the page size as the
    // total is how a screen says "3 rules" about a table holding forty.
    return { routes: applyLimit(matched, options.limit), total: matched.length };
  }

  async assignRoute(input: AssignChannelRoutingInput): Promise<ChannelRoutingRule> {
    const tables = await this.load();
    const surfaceKind = requireString(input.surfaceKind, 'surfaceKind').toLowerCase();
    const profileId = requireString(input.profileId, 'profileId');
    const channelId = optionalString(input.channelId, 'channelId');
    const id = channelRoutingRuleId(surfaceKind, channelId);
    const at = this.stamp();
    const existing = tables.routes.find((rule) => rule.id === id);
    const rule: ChannelRoutingRule = {
      id,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      surfaceKind,
      profileId,
      ...(channelId ? { channelId } : {}),
      ...(optionalString(input.routeId, 'routeId') ? { routeId: optionalString(input.routeId, 'routeId') } : {}),
      ...(optionalString(input.label, 'label') ? { label: optionalString(input.label, 'label') } : {}),
    };
    const routes = [...tables.routes.filter((entry) => entry.id !== id), rule];
    this.tables = { routes, drafts: tables.drafts };
    await this.persist(this.tables);
    return rule;
  }

  async deleteRoute(assignmentId: string): Promise<boolean> {
    const tables = await this.load();
    const id = requireString(assignmentId, 'assignmentId');
    const routes = tables.routes.filter((rule) => rule.id !== id);
    if (routes.length === tables.routes.length) return false;
    this.tables = { routes, drafts: tables.drafts };
    await this.persist(this.tables);
    return true;
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  async listDrafts(options: ListChannelDraftsOptions = {}): Promise<{ drafts: ChannelDraft[]; total: number }> {
    const tables = await this.load();
    const status = options.status?.trim();
    const matched = tables.drafts.filter((draft) => !status || draft.status === status);
    return { drafts: applyLimit(matched, options.limit), total: matched.length };
  }

  async getDraft(draftId: string): Promise<ChannelDraft | null> {
    const tables = await this.load();
    const id = requireString(draftId, 'draftId');
    return tables.drafts.find((draft) => draft.id === id) ?? null;
  }

  async saveDraft(input: Record<string, unknown>): Promise<{ draft: ChannelDraft; created: boolean }> {
    const tables = await this.load();
    const id = requireString(input.id, 'id');
    const webhook = optionalString(input.webhook, 'webhook');
    if (webhook && looksLikeLiveWebhook(webhook)) {
      // Not stored and not scrubbed silently: a raw value arriving here means
      // the surface's redaction did not run, and quietly dropping it would let
      // that keep being true while everything looked fine.
      throw new ChannelSyncError(
        'webhook must be redacted before a draft is mirrored; a live webhook URL is a credential and is refused',
        'INVALID_ARGUMENT',
        'webhook',
      );
    }
    const version = typeof input.version === 'number' && Number.isFinite(input.version) ? input.version : 1;
    const at = this.stamp();
    const existing = tables.drafts.find((draft) => draft.id === id);
    const tags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined;
    const draft: ChannelDraft = {
      version,
      id,
      createdAt: optionalString(input.createdAt, 'createdAt') ?? existing?.createdAt ?? at,
      updatedAt: at,
      status: requireStatus(input.status),
      message: requireString(input.message, 'message'),
      ...(optionalString(input.title, 'title') ? { title: optionalString(input.title, 'title') } : {}),
      ...(optionalString(input.channel, 'channel') ? { channel: optionalString(input.channel, 'channel') } : {}),
      ...(optionalString(input.route, 'route') ? { route: optionalString(input.route, 'route') } : {}),
      ...(webhook ? { webhook } : {}),
      ...(optionalString(input.link, 'link') ? { link: optionalString(input.link, 'link') } : {}),
      ...(tags ? { tags } : {}),
      ...(optionalString(input.sentResponseId, 'sentResponseId')
        ? { sentResponseId: optionalString(input.sentResponseId, 'sentResponseId') }
        : {}),
      ...(optionalString(input.sendError, 'sendError') ? { sendError: optionalString(input.sendError, 'sendError') } : {}),
    };
    const drafts = [...tables.drafts.filter((entry) => entry.id !== id), draft];
    this.tables = { routes: tables.routes, drafts };
    await this.persist(this.tables);
    return { draft, created: existing === undefined };
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    const tables = await this.load();
    const id = requireString(draftId, 'draftId');
    const drafts = tables.drafts.filter((draft) => draft.id !== id);
    if (drafts.length === tables.drafts.length) return false;
    this.tables = { routes: tables.routes, drafts };
    await this.persist(this.tables);
    return true;
  }
}
