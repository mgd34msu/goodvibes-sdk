export type BrowserKnowledgeFamily = 'chromium' | 'gecko' | 'webkit';

export type BrowserKnowledgeKind =
  | 'chrome'
  | 'chromium'
  | 'brave'
  | 'edge'
  | 'vivaldi'
  | 'arc'
  | 'opera'
  | 'firefox'
  | 'zen'
  | 'librewolf'
  | 'waterfox'
  | 'floorp'
  | 'safari'
  | 'orion'
  | 'epiphany';

export type BrowserKnowledgeSourceKind = 'history' | 'bookmark';

export interface BrowserKnowledgeProfile {
  readonly family: BrowserKnowledgeFamily;
  readonly browser: BrowserKnowledgeKind;
  readonly profileName: string;
  readonly profilePath: string;
  readonly historyPath?: string | undefined;
  readonly bookmarksPath?: string | undefined;
}

export interface BrowserHistoryEntry {
  readonly sourceKind: 'history';
  readonly url: string;
  readonly title?: string | undefined;
  readonly browser: BrowserKnowledgeKind;
  readonly family: BrowserKnowledgeFamily;
  readonly profileName: string;
  readonly profilePath: string;
  readonly visitedAtMs?: number | undefined;
  readonly visitCount?: number | undefined;
  readonly transition?: string | undefined;
  readonly rawId?: string | number | undefined;
}

export interface BrowserBookmarkEntry {
  readonly sourceKind: 'bookmark';
  readonly url: string;
  readonly title?: string | undefined;
  readonly browser: BrowserKnowledgeKind;
  readonly family: BrowserKnowledgeFamily;
  readonly profileName: string;
  readonly profilePath: string;
  readonly folderPath?: string | undefined;
  readonly addedAtMs?: number | undefined;
  readonly rawId?: string | number | undefined;
}

export type BrowserKnowledgeEntry = BrowserHistoryEntry | BrowserBookmarkEntry;

export interface BrowserKnowledgeFilter {
  readonly browsers?: readonly BrowserKnowledgeKind[] | undefined;
  readonly sourceKinds?: readonly BrowserKnowledgeSourceKind[] | undefined;
  readonly homeOverride?: string | undefined;
  readonly limit?: number | undefined;
  readonly sinceMs?: number | undefined;
}

export interface BrowserKnowledgeCollectResult {
  readonly profiles: readonly BrowserKnowledgeProfile[];
  readonly entries: readonly BrowserKnowledgeEntry[];
  readonly errors: readonly string[];
}

