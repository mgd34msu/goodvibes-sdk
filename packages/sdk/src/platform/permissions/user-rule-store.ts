/**
 * Durable user-origin permission rules — approval decisions that persist.
 *
 * A "remember" decision with a generalizing tier (exact command / command
 * class / path scope / whole tool) writes a PolicyRule with origin 'user'
 * here. PermissionManager consults these rules before ever prompting (the
 * in-memory session map is just a cache in front), and evaluateRuntimePolicy
 * folds them into the layered evaluator when the policy engine flag is on —
 * user rules are evaluated ahead of managed rules there.
 *
 * Storage: one JSON file per project (control-plane config dir), atomic
 * writes via PersistentStore; ':memory:' for tests. Rules are project-scoped
 * by where the file lives.
 */

import type { PolicyRule } from '../runtime/permissions/types.js';
import { PersistentStore } from '../state/persistent-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { RememberTier } from './approval-rules.js';

/** A stored rule plus its provenance. */
export interface StoredUserPermissionRule {
  readonly rule: PolicyRule;
  readonly createdAt: number;
  /** The remember tier that produced this rule. */
  readonly tier: Exclude<RememberTier, 'session'>;
  /** The tool whose ask produced the rule (display context). */
  readonly tool: string;
}

interface UserRuleFile extends Record<string, unknown> {
  version: 1;
  rules: StoredUserPermissionRule[];
}

export class UserPermissionRuleStore {
  private readonly store: PersistentStore<UserRuleFile>;
  private records: StoredUserPermissionRule[] = [];
  private loaded = false;

  constructor(filePath: string) {
    this.store = new PersistentStore<UserRuleFile>(filePath);
  }

  /** Load persisted rules. Safe to call more than once. */
  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await this.store.load();
      if (data && Array.isArray(data.rules)) {
        this.records = data.rules.filter(
          (record): record is StoredUserPermissionRule =>
            !!record && typeof record === 'object' && !!(record as StoredUserPermissionRule).rule,
        );
      }
    } catch (error) {
      // A corrupt store must not silently grant or deny anything — start
      // empty (every ask prompts again) and say so.
      logger.warn('user permission rule store unreadable; starting with no durable rules', {
        error: summarizeError(error),
      });
      this.records = [];
    }
    this.loaded = true;
  }

  /** All stored rules, newest first. */
  list(): readonly StoredUserPermissionRule[] {
    return [...this.records].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Just the PolicyRules, for evaluation (insertion order — first match wins). */
  rules(): readonly PolicyRule[] {
    return this.records.map((record) => record.rule);
  }

  async add(record: StoredUserPermissionRule): Promise<void> {
    this.records = [...this.records, record];
    await this.persist();
  }

  /** Delete by rule id. Returns whether a rule was removed. */
  async delete(ruleId: string): Promise<boolean> {
    const next = this.records.filter((record) => record.rule.id !== ruleId);
    const removed = next.length !== this.records.length;
    if (removed) {
      this.records = next;
      await this.persist();
    }
    return removed;
  }

  private async persist(): Promise<void> {
    await this.store.persist({ version: 1, rules: this.records });
  }
}
