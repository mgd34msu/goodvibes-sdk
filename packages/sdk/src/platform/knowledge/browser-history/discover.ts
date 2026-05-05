import { access, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  expandBrowserRoots,
  getBrowserPathEntry,
  listBrowserKinds,
  profileGlobToRegex,
} from './paths.js';
import type { BrowserKnowledgeFilter, BrowserKnowledgeKind, BrowserKnowledgeProfile } from './types.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function matchingSubdirs(dir: string, pattern: RegExp): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name);
}

async function buildProfile(
  browser: BrowserKnowledgeKind,
  profilePath: string,
  profileName: string,
): Promise<BrowserKnowledgeProfile | null> {
  const entry = getBrowserPathEntry(browser);
  const historyPath = join(profilePath, entry.historyFile);
  const bookmarksPath = join(profilePath, entry.bookmarksFile);
  const [historyExists, bookmarksExists] = await Promise.all([
    pathExists(historyPath),
    pathExists(bookmarksPath),
  ]);
  if (!historyExists && !bookmarksExists) return null;
  return {
    family: entry.family,
    browser,
    profileName,
    profilePath,
    ...(historyExists ? { historyPath } : {}),
    ...(bookmarksExists ? { bookmarksPath } : {}),
  };
}

export async function discoverBrowserKnowledgeProfiles(
  filter: Pick<BrowserKnowledgeFilter, 'browsers' | 'homeOverride'> = {},
): Promise<BrowserKnowledgeProfile[]> {
  const wanted = filter.browsers?.length ? new Set(filter.browsers) : null;
  const seen = new Set<string>();
  const profiles: BrowserKnowledgeProfile[] = [];

  for (const browser of listBrowserKinds()) {
    if (wanted && !wanted.has(browser)) continue;
    const entry = getBrowserPathEntry(browser);
    const roots = expandBrowserRoots(browser, filter.homeOverride);
    const profileRegex = profileGlobToRegex(browser);

    for (const root of roots) {
      if (browser === 'safari' || browser === 'epiphany') {
        const profileName = 'Default';
        const profilePath = root;
        if (seen.has(profilePath)) continue;
        const profile = await buildProfile(browser, profilePath, profileName);
        if (profile) {
          seen.add(profilePath);
          profiles.push(profile);
        }
        continue;
      }

      const names = await matchingSubdirs(root, profileRegex);
      for (const profileName of names) {
        const rawProfilePath = join(root, profileName);
        let profilePath = rawProfilePath;
        try {
          profilePath = await realpath(rawProfilePath);
        } catch {
          // Keep the raw path if symlink resolution is unavailable.
        }
        if (seen.has(profilePath)) continue;
        const profile = await buildProfile(browser, profilePath, profileName);
        if (!profile) continue;
        if (entry.family === 'webkit' && profile.browser === 'orion' && !profile.historyPath) continue;
        seen.add(profilePath);
        profiles.push(profile);
      }
    }
  }

  return profiles;
}
