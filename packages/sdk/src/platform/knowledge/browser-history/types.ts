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
  readonly historyPath?: string;
  readonly bookmarksPath?: string;
}

export interface BrowserHistoryEntry {
  readonly sourceKind: 'history';
  readonly url: string;
  readonly title?: string;
  readonly browser: BrowserKnowledgeKind;
  readonly family: BrowserKnowledgeFamily;
  readonly profileName: string;
  readonly profilePath: string;
  readonly visitedAtMs?: number;
  readonly visitCount?: number;
  readonly transition?: string;
  readonly rawId?: string | number;
}

export interface BrowserBookmarkEntry {
  readonly sourceKind: 'bookmark';
  readonly url: string;
  readonly title?: string;
  readonly browser: BrowserKnowledgeKind;
  readonly family: BrowserKnowledgeFamily;
  readonly profileName: string;
  readonly profilePath: string;
  readonly folderPath?: string;
  readonly addedAtMs?: number;
  readonly rawId?: string | number;
}

export type BrowserKnowledgeEntry = BrowserHistoryEntry | BrowserBookmarkEntry;

export interface BrowserKnowledgeFilter {
  readonly browsers?: readonly BrowserKnowledgeKind[];
  readonly sourceKinds?: readonly BrowserKnowledgeSourceKind[];
  readonly homeOverride?: string;
  readonly limit?: number;
  readonly sinceMs?: number;
}

export interface BrowserKnowledgeCollectResult {
  readonly profiles: readonly BrowserKnowledgeProfile[];
  readonly entries: readonly BrowserKnowledgeEntry[];
  readonly errors: readonly string[];
}

