import type { KnowledgeProjectionTarget } from './types.js';

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function quote(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `> ${trimmed.replace(/\n+/g, '\n> ')}` : null;
}

export function formatDateTime(timestamp: number | undefined): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

export function codeFenceJson(value: Record<string, unknown> | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

export function joinSections(...sections: Array<string | null | undefined>): string {
  return sections.filter((section): section is string => typeof section === 'string' && section.trim().length > 0).join('\n\n');
}

export function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

export function buildBulletList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- none';
}

export function sortByTitle<T extends { title?: string }>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
}

export function materializedTargetReference(target: KnowledgeProjectionTarget): {
  readonly kind: 'source' | 'node';
  readonly id: string;
} | null {
  if ((target.kind === 'source' || target.kind === 'node') && target.itemId) {
    return { kind: target.kind, id: target.itemId };
  }
  return null;
}
