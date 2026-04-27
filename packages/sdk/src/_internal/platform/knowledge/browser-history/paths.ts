import { homedir } from 'node:os';
import { normalize } from 'node:path';
import type { BrowserKnowledgeFamily, BrowserKnowledgeKind } from './types.js';

interface BrowserPathEntry {
  readonly family: BrowserKnowledgeFamily;
  readonly paths: Partial<Record<'linux' | 'darwin', readonly string[]>>;
  readonly profileGlob: string;
  readonly historyFile: string;
  readonly bookmarksFile: string;
}

const CHROMIUM_PROFILES = '(Default|Profile .+|Guest Profile)';
const GECKO_PROFILES = '(.+\\.default|.+\\.default-release|.+\\.dev-edition-default|[a-z0-9]+\\..+)';

export const BROWSER_PATHS: Record<BrowserKnowledgeKind, BrowserPathEntry> = {
  chrome: {
    family: 'chromium',
    paths: { linux: ['~/.config/google-chrome', '~/.config/google-chrome-beta'], darwin: ['~/Library/Application Support/Google/Chrome'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  chromium: {
    family: 'chromium',
    paths: { linux: ['~/.config/chromium'], darwin: ['~/Library/Application Support/Chromium'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  brave: {
    family: 'chromium',
    paths: { linux: ['~/.config/BraveSoftware/Brave-Browser'], darwin: ['~/Library/Application Support/BraveSoftware/Brave-Browser'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  edge: {
    family: 'chromium',
    paths: { linux: ['~/.config/microsoft-edge', '~/.config/microsoft-edge-dev'], darwin: ['~/Library/Application Support/Microsoft Edge'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  vivaldi: {
    family: 'chromium',
    paths: { linux: ['~/.config/vivaldi'], darwin: ['~/Library/Application Support/Vivaldi'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  arc: {
    family: 'chromium',
    paths: { darwin: ['~/Library/Application Support/Arc/User Data'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  opera: {
    family: 'chromium',
    paths: { linux: ['~/.config/opera'], darwin: ['~/Library/Application Support/com.operasoftware.Opera'] },
    profileGlob: CHROMIUM_PROFILES,
    historyFile: 'History',
    bookmarksFile: 'Bookmarks',
  },
  firefox: {
    family: 'gecko',
    paths: { linux: ['~/.mozilla/firefox', '~/snap/firefox/common/.mozilla/firefox', '~/.var/app/org.mozilla.firefox/.mozilla/firefox'], darwin: ['~/Library/Application Support/Firefox/Profiles'] },
    profileGlob: GECKO_PROFILES,
    historyFile: 'places.sqlite',
    bookmarksFile: 'places.sqlite',
  },
  zen: {
    family: 'gecko',
    paths: { linux: ['~/.zen'], darwin: ['~/Library/Application Support/zen/Profiles'] },
    profileGlob: '(.+\\.default|.+\\.default-release|[a-z0-9]+\\..+)',
    historyFile: 'places.sqlite',
    bookmarksFile: 'places.sqlite',
  },
  librewolf: {
    family: 'gecko',
    paths: { linux: ['~/.librewolf'], darwin: ['~/Library/Application Support/LibreWolf/Profiles'] },
    profileGlob: '(.+\\.default|.+\\.default-release|[a-z0-9]+\\..+)',
    historyFile: 'places.sqlite',
    bookmarksFile: 'places.sqlite',
  },
  waterfox: {
    family: 'gecko',
    paths: { linux: ['~/.waterfox'], darwin: ['~/Library/Application Support/Waterfox/Profiles'] },
    profileGlob: '(.+\\.default|.+\\.default-release|[a-z0-9]+\\..+)',
    historyFile: 'places.sqlite',
    bookmarksFile: 'places.sqlite',
  },
  floorp: {
    family: 'gecko',
    paths: { linux: ['~/.floorp'], darwin: ['~/Library/Application Support/Floorp/Profiles'] },
    profileGlob: '(.+\\.default|.+\\.default-release|[a-z0-9]+\\..+)',
    historyFile: 'places.sqlite',
    bookmarksFile: 'places.sqlite',
  },
  safari: {
    family: 'webkit',
    paths: { darwin: ['~/Library/Safari'] },
    profileGlob: '(Default)',
    historyFile: 'History.db',
    bookmarksFile: 'Bookmarks.plist',
  },
  orion: {
    family: 'webkit',
    paths: { darwin: ['~/Library/Application Support/Orion'] },
    profileGlob: '(Default|Profile .+)',
    historyFile: 'History.db',
    bookmarksFile: 'Bookmarks.plist',
  },
  epiphany: {
    family: 'webkit',
    paths: { linux: ['~/.local/share/epiphany', '~/.var/app/org.gnome.Epiphany/data/epiphany'] },
    profileGlob: '(Default)',
    historyFile: 'ephy-history.db',
    bookmarksFile: 'bookmarks.gvdb',
  },
};

export function listBrowserKinds(): BrowserKnowledgeKind[] {
  return Object.keys(BROWSER_PATHS) as BrowserKnowledgeKind[];
}

export function getBrowserPathEntry(kind: BrowserKnowledgeKind): BrowserPathEntry {
  return BROWSER_PATHS[kind];
}

export function expandBrowserRoots(kind: BrowserKnowledgeKind, homeOverride?: string): string[] {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const home = homeOverride ?? homedir();
  return (BROWSER_PATHS[kind].paths[platform] ?? []).map((entry) => normalize(entry.replace(/^~/, home)));
}

export function profileGlobToRegex(kind: BrowserKnowledgeKind): RegExp {
  return new RegExp(`^(?:${BROWSER_PATHS[kind].profileGlob})$`);
}

