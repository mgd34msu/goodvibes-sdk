import { readFile } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import bplistParserDefault from 'bplist-parser';
import { copyLockedBrowserSqlite } from './locked-db.js';
import type {
  BrowserBookmarkEntry,
  BrowserHistoryEntry,
  BrowserKnowledgeEntry,
  BrowserKnowledgeProfile,
} from './types.js';

const bplistParser = bplistParserDefault as unknown as {
  parseFileSync<T = unknown>(path: string): T[];
};

export interface BrowserKnowledgeReadOptions {
  readonly limit?: number;
  readonly sinceMs?: number;
  readonly sourceKinds?: readonly ('history' | 'bookmark')[];
}

const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;
const MAC_ABSOLUTE_TIME_OFFSET_S = 978_307_200;

function chromiumMicrosToMs(micros: number): number {
  return Math.floor(micros / 1000) - CHROMIUM_EPOCH_OFFSET_MS;
}

function msToChromiumMicros(ms: number): number {
  return Math.floor((ms + CHROMIUM_EPOCH_OFFSET_MS) * 1000);
}

function geckoMicrosToMs(micros: number): number {
  return Math.floor(micros / 1000);
}

function macAbsoluteTimeToMs(seconds: number): number {
  return Math.floor((seconds + MAC_ABSOLUTE_TIME_OFFSET_S) * 1000);
}

function msToMacAbsoluteSeconds(ms: number): number {
  return Math.floor(ms / 1000) - MAC_ABSOLUTE_TIME_OFFSET_S;
}

function cleanOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function decodeChromiumTransition(raw: number): string {
  return ({
    0: 'LINK',
    1: 'TYPED',
    2: 'AUTO_BOOKMARK',
    3: 'AUTO_SUBFRAME',
    4: 'MANUAL_SUBFRAME',
    5: 'GENERATED',
    6: 'START_PAGE',
    7: 'FORM_SUBMIT',
    8: 'RELOAD',
    9: 'KEYWORD',
    10: 'KEYWORD_GENERATED',
  } as Record<number, string>)[raw & 0xff] ?? 'UNKNOWN';
}

function decodeGeckoVisitType(visitType: number): string {
  return ({
    1: 'LINK',
    2: 'TYPED',
    3: 'BOOKMARK',
    4: 'EMBED',
    5: 'PERMANENT_REDIRECT',
    6: 'TEMPORARY_REDIRECT',
    7: 'DOWNLOAD',
    8: 'FRAMED_LINK',
    9: 'RELOAD',
  } as Record<number, string>)[visitType] ?? 'UNKNOWN';
}

function normalizeLimit(limit: number | undefined, fallback = 1000): number {
  const candidate = typeof limit === 'number' && Number.isFinite(limit) ? limit : fallback;
  return Math.max(1, Math.min(50_000, Math.floor(candidate)));
}

type ChromiumUrlRow = { id: number; url: string; title: string | null; visit_count: number };
type ChromiumVisitRow = { url: number; visit_time: number; transition: number };

async function readChromiumHistory(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserHistoryEntry[]> {
  if (!profile.historyPath) return [];
  const limit = normalizeLimit(options.limit);
  const since = typeof options.sinceMs === 'number' ? msToChromiumMicros(options.sinceMs) : 0;
  const copy = await copyLockedBrowserSqlite(profile.historyPath);
  try {
    const db = new Database(copy.copiedDbPath, { readonly: true });
    try {
      const urlRows = db.query<ChromiumUrlRow, []>('SELECT id, url, title, visit_count FROM urls').all();
      const urlMap = new Map(urlRows.map((row) => [row.id, row]));
      const visitRows = db.query<ChromiumVisitRow, [number, number]>(
        `SELECT url, visit_time, transition
         FROM visits
         WHERE visit_time >= ?
         ORDER BY visit_time DESC
         LIMIT ?`,
      ).all(since, limit);
      return visitRows.flatMap((visit) => {
        const url = urlMap.get(visit.url);
        if (!url?.url) return [];
        return [{
          sourceKind: 'history' as const,
          url: url.url,
          ...(cleanOptionalText(url.title) ? { title: cleanOptionalText(url.title) } : {}),
          browser: profile.browser,
          family: profile.family,
          profileName: profile.profileName,
          profilePath: profile.profilePath,
          visitedAtMs: chromiumMicrosToMs(visit.visit_time),
          visitCount: url.visit_count,
          transition: decodeChromiumTransition(visit.transition),
          rawId: url.id,
        }];
      });
    } finally {
      db.close();
    }
  } finally {
    await copy.cleanup();
  }
}

interface ChromiumBookmarkNode {
  readonly id?: string;
  readonly type?: 'url' | 'folder';
  readonly name?: string;
  readonly url?: string;
  readonly date_added?: string;
  readonly children?: readonly ChromiumBookmarkNode[];
}

function walkChromiumBookmarkNode(
  profile: BrowserKnowledgeProfile,
  node: ChromiumBookmarkNode,
  folders: readonly string[],
  out: BrowserBookmarkEntry[],
  limit: number,
): void {
  if (out.length >= limit) return;
  if (node.type === 'url') {
    const url = cleanOptionalText(node.url);
    if (!url) return;
    const micros = Number(node.date_added ?? 0);
    out.push({
      sourceKind: 'bookmark',
      url,
      ...(cleanOptionalText(node.name) ? { title: cleanOptionalText(node.name) } : {}),
      browser: profile.browser,
      family: profile.family,
      profileName: profile.profileName,
      profilePath: profile.profilePath,
      ...(folders.length ? { folderPath: `/${folders.join('/')}` } : {}),
      ...(Number.isFinite(micros) && micros > 0 ? { addedAtMs: chromiumMicrosToMs(micros) } : {}),
      ...(node.id ? { rawId: node.id } : {}),
    });
    return;
  }
  if (node.type === 'folder') {
    const nextFolders = cleanOptionalText(node.name) ? [...folders, node.name!.trim()] : [...folders];
    for (const child of node.children ?? []) {
      walkChromiumBookmarkNode(profile, child, nextFolders, out, limit);
      if (out.length >= limit) return;
    }
  }
}

async function readChromiumBookmarks(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserBookmarkEntry[]> {
  if (!profile.bookmarksPath) return [];
  const limit = normalizeLimit(options.limit);
  const parsed = JSON.parse(await readFile(profile.bookmarksPath, 'utf8')) as {
    roots?: Record<string, ChromiumBookmarkNode | undefined>;
  };
  const out: BrowserBookmarkEntry[] = [];
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = parsed.roots?.[key];
    if (!root) continue;
    walkChromiumBookmarkNode(profile, root, [], out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

type GeckoVisitRow = {
  place_id: number;
  url: string;
  title: string | null;
  visit_count: number;
  visit_date: number;
  visit_type: number;
};

async function readGeckoHistory(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserHistoryEntry[]> {
  if (!profile.historyPath) return [];
  const copy = await copyLockedBrowserSqlite(profile.historyPath);
  try {
    const db = new Database(copy.copiedDbPath, { readonly: true });
    try {
      const since = typeof options.sinceMs === 'number' ? Math.floor(options.sinceMs * 1000) : 0;
      const rows = db.query<GeckoVisitRow, [number, number]>(
        `SELECT p.id AS place_id, p.url, p.title, p.visit_count, h.visit_date, h.visit_type
         FROM moz_historyvisits h
         JOIN moz_places p ON p.id = h.place_id
         WHERE p.hidden = 0 AND h.visit_date >= ?
         ORDER BY h.visit_date DESC
         LIMIT ?`,
      ).all(since, normalizeLimit(options.limit));
      return rows.map((row) => ({
        sourceKind: 'history',
        url: row.url,
        ...(cleanOptionalText(row.title) ? { title: cleanOptionalText(row.title) } : {}),
        browser: profile.browser,
        family: profile.family,
        profileName: profile.profileName,
        profilePath: profile.profilePath,
        visitedAtMs: geckoMicrosToMs(row.visit_date),
        visitCount: row.visit_count,
        transition: decodeGeckoVisitType(row.visit_type),
        rawId: row.place_id,
      }));
    } finally {
      db.close();
    }
  } finally {
    await copy.cleanup();
  }
}

type GeckoBookmarkRow = { id: number; type: number; parent: number; title: string | null; fk: number | null; dateAdded: number };
type GeckoPlaceRow = { id: number; url: string; title: string | null };

const GECKO_ROOT_LABELS: Record<number, string> = {
  1: 'root',
  2: 'Bookmarks Menu',
  3: 'Bookmarks Toolbar',
  4: 'Tags',
  5: 'Other Bookmarks',
  6: 'Mobile Bookmarks',
};

function geckoFolderPath(parent: number, rows: Map<number, GeckoBookmarkRow>): string | undefined {
  const segments: string[] = [];
  const visited = new Set<number>();
  let current = parent;
  while (current > 0 && !visited.has(current)) {
    visited.add(current);
    const row = rows.get(current);
    if (!row) break;
    const root = GECKO_ROOT_LABELS[current];
    if (root) {
      segments.unshift(root);
      break;
    }
    if (row.title) segments.unshift(row.title);
    current = row.parent;
  }
  return segments.length ? `/${segments.join('/')}` : undefined;
}

async function readGeckoBookmarks(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserBookmarkEntry[]> {
  const path = profile.bookmarksPath ?? profile.historyPath;
  if (!path) return [];
  const copy = await copyLockedBrowserSqlite(path);
  try {
    const db = new Database(copy.copiedDbPath, { readonly: true });
    try {
      const rows = db.query<GeckoBookmarkRow, []>('SELECT id, type, parent, title, fk, dateAdded FROM moz_bookmarks ORDER BY id').all();
      const places = db.query<GeckoPlaceRow, []>('SELECT id, url, title FROM moz_places').all();
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const placeById = new Map(places.map((place) => [place.id, place]));
      const out: BrowserBookmarkEntry[] = [];
      for (const row of rows) {
        if (out.length >= normalizeLimit(options.limit)) break;
        if (row.type !== 1 || row.fk === null) continue;
        const place = placeById.get(row.fk);
        if (!place?.url) continue;
        const addedAtMs = Math.max(0, Math.floor(row.dateAdded / 1000));
        out.push({
          sourceKind: 'bookmark',
          url: place.url,
          ...(cleanOptionalText(row.title ?? place.title) ? { title: cleanOptionalText(row.title ?? place.title) } : {}),
          browser: profile.browser,
          family: profile.family,
          profileName: profile.profileName,
          profilePath: profile.profilePath,
          ...(geckoFolderPath(row.parent, rowById) ? { folderPath: geckoFolderPath(row.parent, rowById) } : {}),
          ...(addedAtMs > 0 ? { addedAtMs } : {}),
          rawId: row.id,
        });
      }
      return out;
    } finally {
      db.close();
    }
  } finally {
    await copy.cleanup();
  }
}

type SafariHistoryItem = { id: number; url: string; visit_count: number; title: string | null };
type SafariHistoryVisit = { history_item: number; visit_time: number; title: string | null };
type EphyUrlRow = { id: number; url: string; title: string | null; visit_count: number; last_visit_time: number };

async function readWebKitHistory(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserHistoryEntry[]> {
  if (!profile.historyPath) return [];
  const copy = await copyLockedBrowserSqlite(profile.historyPath);
  try {
    const db = new Database(copy.copiedDbPath, { readonly: true });
    try {
      if (profile.browser === 'epiphany') {
        const since = typeof options.sinceMs === 'number' ? Math.floor(options.sinceMs / 1000) : 0;
        const rows = db.query<EphyUrlRow, [number, number]>(
          'SELECT id, url, title, visit_count, last_visit_time FROM urls WHERE last_visit_time >= ? ORDER BY last_visit_time DESC LIMIT ?',
        ).all(since, normalizeLimit(options.limit));
        return rows.map((row) => ({
          sourceKind: 'history',
          url: row.url,
          ...(cleanOptionalText(row.title) ? { title: cleanOptionalText(row.title) } : {}),
          browser: profile.browser,
          family: profile.family,
          profileName: profile.profileName,
          profilePath: profile.profilePath,
          visitedAtMs: row.last_visit_time * 1000,
          visitCount: row.visit_count,
          rawId: row.id,
        }));
      }
      const items = db.query<SafariHistoryItem, []>('SELECT id, url, visit_count, title FROM history_items').all();
      const itemById = new Map(items.map((item) => [item.id, item]));
      const since = typeof options.sinceMs === 'number' ? msToMacAbsoluteSeconds(options.sinceMs) : 0;
      const rows = db.query<SafariHistoryVisit, [number, number]>(
        'SELECT history_item, visit_time, title FROM history_visits WHERE visit_time >= ? ORDER BY visit_time DESC LIMIT ?',
      ).all(since, normalizeLimit(options.limit));
      return rows.flatMap((visit) => {
        const item = itemById.get(visit.history_item);
        if (!item?.url) return [];
        return [{
          sourceKind: 'history' as const,
          url: item.url,
          ...(cleanOptionalText(visit.title ?? item.title) ? { title: cleanOptionalText(visit.title ?? item.title) } : {}),
          browser: profile.browser,
          family: profile.family,
          profileName: profile.profileName,
          profilePath: profile.profilePath,
          visitedAtMs: macAbsoluteTimeToMs(visit.visit_time),
          visitCount: item.visit_count,
          rawId: item.id,
        }];
      });
    } finally {
      db.close();
    }
  } finally {
    await copy.cleanup();
  }
}

interface WebKitBookmarkNode {
  readonly WebBookmarkType?: string;
  readonly URLString?: string;
  readonly URIDictionary?: { readonly title?: string };
  readonly Title?: string;
  readonly Children?: readonly WebKitBookmarkNode[];
  readonly WebBookmarkDateAdded?: number;
}

function walkWebKitBookmarkNode(
  profile: BrowserKnowledgeProfile,
  node: WebKitBookmarkNode,
  folderPath: string,
  out: BrowserBookmarkEntry[],
  limit: number,
): void {
  if (out.length >= limit) return;
  if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
    const url = cleanOptionalText(node.URLString);
    if (!url) return;
    out.push({
      sourceKind: 'bookmark',
      url,
      ...(cleanOptionalText(node.URIDictionary?.title) ? { title: cleanOptionalText(node.URIDictionary?.title) } : {}),
      browser: profile.browser,
      family: profile.family,
      profileName: profile.profileName,
      profilePath: profile.profilePath,
      ...(folderPath ? { folderPath } : {}),
      ...(typeof node.WebBookmarkDateAdded === 'number' ? { addedAtMs: macAbsoluteTimeToMs(node.WebBookmarkDateAdded) } : {}),
    });
    return;
  }
  if (node.WebBookmarkType === 'WebBookmarkTypeList') {
    const next = cleanOptionalText(node.Title) ? `${folderPath}/${node.Title!.trim()}` : folderPath;
    for (const child of node.Children ?? []) {
      walkWebKitBookmarkNode(profile, child, next, out, limit);
      if (out.length >= limit) return;
    }
  }
}

async function readWebKitBookmarks(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserBookmarkEntry[]> {
  if (!profile.bookmarksPath || profile.browser === 'epiphany') return [];
  const [root] = bplistParser.parseFileSync<WebKitBookmarkNode>(profile.bookmarksPath);
  const out: BrowserBookmarkEntry[] = [];
  for (const child of root.Children ?? []) {
    walkWebKitBookmarkNode(profile, child, '', out, normalizeLimit(options.limit));
    if (out.length >= normalizeLimit(options.limit)) break;
  }
  return out;
}

export async function readBrowserKnowledgeProfile(
  profile: BrowserKnowledgeProfile,
  options: BrowserKnowledgeReadOptions = {},
): Promise<BrowserKnowledgeEntry[]> {
  const kinds = new Set(options.sourceKinds ?? ['history', 'bookmark']);
  const entries: BrowserKnowledgeEntry[] = [];
  if (kinds.has('history')) {
    if (profile.family === 'chromium') entries.push(...await readChromiumHistory(profile, options));
    if (profile.family === 'gecko') entries.push(...await readGeckoHistory(profile, options));
    if (profile.family === 'webkit') entries.push(...await readWebKitHistory(profile, options));
  }
  if (kinds.has('bookmark')) {
    if (profile.family === 'chromium') entries.push(...await readChromiumBookmarks(profile, options));
    if (profile.family === 'gecko') entries.push(...await readGeckoBookmarks(profile, options));
    if (profile.family === 'webkit') entries.push(...await readWebKitBookmarks(profile, options));
  }
  return entries.slice(0, normalizeLimit(options.limit, 2000));
}
