import { describe, expect, test } from 'bun:test';
import {
  parseTrainStatusManifest,
  classifySdkPin,
  deriveAction,
  deriveRow,
  errorRow,
  renderTrainStatusTable,
  renderTrainStatusJson,
  countNeedingAction,
  type RepoGathered,
  type RepoRow,
  type TrainStatusRepoEntry,
} from '@pellux/goodvibes-toolchain';

function entry(overrides: Partial<TrainStatusRepoEntry> = {}): TrainStatusRepoEntry {
  return { path: '/repos/x', name: 'x', kind: 'independent', ...overrides };
}

function gathered(overrides: Partial<RepoGathered> = {}): RepoGathered {
  return {
    entry: entry(),
    version: '1.0.0',
    sdkPin: null,
    lastTag: null,
    commitsSinceTag: 0,
    unpushedCommits: 0,
    ...overrides,
  };
}

describe('parseTrainStatusManifest', () => {
  test('parses a minimal manifest', () => {
    const manifest = parseTrainStatusManifest(JSON.stringify({
      repos: [{ path: '/a', name: 'a', kind: 'sdk' }],
    }));
    expect(manifest.repos).toHaveLength(1);
    expect(manifest.repos[0]!.kind).toBe('sdk');
  });

  test('accepts an optional releaseCommand', () => {
    const manifest = parseTrainStatusManifest(JSON.stringify({
      repos: [{ path: '/a', name: 'a', kind: 'independent', releaseCommand: './scripts/release.sh' }],
    }));
    expect(manifest.repos[0]!.releaseCommand).toBe('./scripts/release.sh');
  });

  test('rejects a manifest with no repos', () => {
    expect(() => parseTrainStatusManifest(JSON.stringify({ repos: [] }))).toThrow(/repos/);
  });

  test('rejects a missing repos field', () => {
    expect(() => parseTrainStatusManifest('{}')).toThrow(/repos/);
  });

  test('rejects an invalid kind, naming the field', () => {
    expect(() => parseTrainStatusManifest(JSON.stringify({
      repos: [{ path: '/a', name: 'a', kind: 'bogus' }],
    }))).toThrow(/kind/);
  });

  test('rejects a repo missing name, naming the field', () => {
    expect(() => parseTrainStatusManifest(JSON.stringify({
      repos: [{ path: '/a', kind: 'sdk' }],
    }))).toThrow(/name/);
  });

  test('rejects a non-object manifest', () => {
    expect(() => parseTrainStatusManifest('[]')).toThrow();
  });
});

describe('classifySdkPin', () => {
  test('non-consumer kinds are n/a regardless of pin', () => {
    expect(classifySdkPin('1.0.0', '1.0.0', 'sdk')).toBe('n/a');
    expect(classifySdkPin('1.0.0', '1.0.0', 'independent')).toBe('n/a');
  });
  test('unpinned consumer', () => {
    expect(classifySdkPin(null, '1.0.0', 'sdk-consumer')).toBe('unpinned');
  });
  test('pin matches latest: current', () => {
    expect(classifySdkPin('1.2.3', '1.2.3', 'sdk-consumer')).toBe('1.2.3 (current)');
  });
  test('pin behind latest: repin needed', () => {
    expect(classifySdkPin('1.2.0', '1.2.3', 'sdk-consumer')).toBe('1.2.0 -> 1.2.3 (repin needed)');
  });
  test('latest unknown (npm view failed)', () => {
    expect(classifySdkPin('1.2.0', null, 'sdk-consumer')).toBe('1.2.0 (latest unknown)');
  });
});

describe('deriveAction: sdk repos', () => {
  test('idle with no commits since the last tag', () => {
    const g = gathered({ entry: entry({ kind: 'sdk' }), commitsSinceTag: 0 });
    expect(deriveAction(g, null)).toBe('idle');
  });
  test('cut vNEXT when there are commits since the last tag', () => {
    const g = gathered({ entry: entry({ kind: 'sdk' }), commitsSinceTag: 3 });
    expect(deriveAction(g, null)).toBe('cut vNEXT');
  });
});

describe('deriveAction: sdk-consumer repos', () => {
  test('repin takes priority over an unreleased count', () => {
    const g = gathered({
      entry: entry({ kind: 'sdk-consumer' }),
      sdkPin: '1.0.0',
      commitsSinceTag: 5,
    });
    expect(deriveAction(g, '1.1.0')).toBe('repin to 1.1.0 then release');
  });
  test('release (N unreleased) when the pin is current', () => {
    const g = gathered({
      entry: entry({ kind: 'sdk-consumer' }),
      sdkPin: '1.1.0',
      commitsSinceTag: 4,
    });
    expect(deriveAction(g, '1.1.0')).toBe('release (4 unreleased)');
  });
  test('idle when the pin is current and nothing unreleased', () => {
    const g = gathered({
      entry: entry({ kind: 'sdk-consumer' }),
      sdkPin: '1.1.0',
      commitsSinceTag: 0,
    });
    expect(deriveAction(g, '1.1.0')).toBe('idle');
  });
  test('an unresolvable latest version never triggers a repin suggestion', () => {
    const g = gathered({
      entry: entry({ kind: 'sdk-consumer' }),
      sdkPin: '1.1.0',
      commitsSinceTag: 2,
    });
    expect(deriveAction(g, null)).toBe('release (2 unreleased)');
  });
});

describe('deriveAction: independent repos', () => {
  test('release takes priority over unpushed, and includes the manifest releaseCommand verbatim', () => {
    const g = gathered({
      entry: entry({ kind: 'independent', releaseCommand: './scripts/release.sh' }),
      commitsSinceTag: 2,
      unpushedCommits: 5,
    });
    expect(deriveAction(g, null)).toBe('release (2 unreleased): ./scripts/release.sh');
  });
  test('release with no releaseCommand omits the suffix', () => {
    const g = gathered({ entry: entry({ kind: 'independent' }), commitsSinceTag: 1 });
    expect(deriveAction(g, null)).toBe('release (1 unreleased)');
  });
  test('push (N unpushed) when nothing is unreleased but commits are unpushed', () => {
    const g = gathered({ entry: entry({ kind: 'independent' }), commitsSinceTag: 0, unpushedCommits: 3 });
    expect(deriveAction(g, null)).toBe('push (3 unpushed)');
  });
  test('idle when nothing is unreleased or unpushed', () => {
    const g = gathered({ entry: entry({ kind: 'independent' }), commitsSinceTag: 0, unpushedCommits: 0 });
    expect(deriveAction(g, null)).toBe('idle');
  });
});

describe('deriveRow', () => {
  test('carries version, tag, and counts through to the row untouched', () => {
    const g = gathered({
      entry: entry({ kind: 'sdk', name: 'goodvibes-sdk' }),
      version: '2.0.17',
      lastTag: 'v2.0.16',
      commitsSinceTag: 2,
    });
    const row = deriveRow(g, null);
    expect(row).toEqual({
      name: 'goodvibes-sdk',
      kind: 'sdk',
      version: '2.0.17',
      sdkPin: 'n/a',
      lastTag: 'v2.0.16',
      commitsSinceTag: 2,
      unpushedCommits: 0,
      action: 'cut vNEXT',
    });
  });
  test('no tag renders as (none)', () => {
    const row = deriveRow(gathered({ lastTag: null }), null);
    expect(row.lastTag).toBe('(none)');
  });
  test('a repo with no package.json reports version n/a (e.g. a Python repo)', () => {
    const row = deriveRow(gathered({ version: 'n/a' }), null);
    expect(row.version).toBe('n/a');
  });
});

describe('errorRow', () => {
  test('carries the message and marks the row as errored, with an ERROR-prefixed action', () => {
    const row = errorRow(entry({ name: 'broken' }), 'path does not exist: /nope');
    expect(row.error).toBe('path does not exist: /nope');
    expect(row.action).toBe('ERROR: path does not exist: /nope');
    expect(row.name).toBe('broken');
  });
});

describe('countNeedingAction', () => {
  test('excludes idle and errored rows', () => {
    const rows: RepoRow[] = [
      deriveRow(gathered({ entry: entry({ kind: 'sdk' }), commitsSinceTag: 1 }), null), // cut vNEXT
      deriveRow(gathered({ entry: entry({ kind: 'sdk' }), commitsSinceTag: 0 }), null), // idle
      errorRow(entry(), 'not a git repository: /nope'),
    ];
    expect(countNeedingAction(rows)).toBe(1);
  });
});

describe('renderTrainStatusTable', () => {
  test('renders an aligned table with a header row and a summary line', () => {
    const rows: RepoRow[] = [
      deriveRow(gathered({ entry: entry({ kind: 'sdk', name: 'goodvibes-sdk' }), commitsSinceTag: 2 }), null),
      deriveRow(gathered({ entry: entry({ kind: 'independent', name: 'goodvibes-plugin' }), commitsSinceTag: 0, unpushedCommits: 0 }), null),
    ];
    const table = renderTrainStatusTable(rows);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^REPO\s+KIND\s+VERSION\s+SDK PIN\s+LAST TAG\s+SINCE TAG\s+UNPUSHED\s+ACTION$/);
    expect(lines.some((l) => l.includes('goodvibes-sdk') && l.includes('cut vNEXT'))).toBe(true);
    expect(lines.some((l) => l.includes('goodvibes-plugin') && l.includes('idle'))).toBe(true);
    expect(lines.at(-1)).toBe('2 repos, 1 need action');
  });

  test('a single repo pluralizes correctly', () => {
    const rows: RepoRow[] = [deriveRow(gathered(), null)];
    const table = renderTrainStatusTable(rows);
    expect(table.split('\n').at(-1)).toBe('1 repo, 0 need action');
  });

  test('an error row still prints fully alongside healthy rows', () => {
    const rows: RepoRow[] = [
      deriveRow(gathered({ entry: entry({ name: 'ok-repo' }) }), null),
      errorRow(entry({ name: 'broken-repo' }), 'not a git repository: /nope'),
    ];
    const table = renderTrainStatusTable(rows);
    expect(table).toContain('ok-repo');
    expect(table).toContain('broken-repo');
    expect(table).toContain('ERROR: not a git repository: /nope');
    expect(table.split('\n').at(-1)).toBe('2 repos, 0 need action');
  });
});

describe('renderTrainStatusJson', () => {
  test('embeds a computed summary alongside the raw rows', () => {
    const rows: RepoRow[] = [
      deriveRow(gathered({ entry: entry({ kind: 'independent' }), commitsSinceTag: 1 }), null),
    ];
    const parsed = JSON.parse(renderTrainStatusJson({ latestSdkVersion: '1.0.0', rows })) as {
      latestSdkVersion: string | null;
      rows: RepoRow[];
      summary: { total: number; needAction: number };
    };
    expect(parsed.latestSdkVersion).toBe('1.0.0');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.summary).toEqual({ total: 1, needAction: 1 });
  });
});
