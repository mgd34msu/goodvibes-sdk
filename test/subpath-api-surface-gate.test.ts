/**
 * The subpath API gate's own failure paths.
 *
 * This gate exists because `api:check` is blind to `./platform/**`: the two
 * api-extractor rollups cover 806 of the package's 6 361 subpath exports, and
 * 78 of the 140 published subpaths — `./platform/email` among them — appear in
 * neither. Measured, not assumed: changing `EmailSummary.subject` from `string`
 * to `string | null`, rebuilding and running `bunx api-extractor run --local`
 * produced no diff in `etc/goodvibes-sdk.api.md` at all.
 *
 * Every assertion below drives a REJECT path and its matching ACCEPT path. A
 * detector that only ever ran against input it accepts is the failure this
 * whole file is a response to: it reports "covered" forever and nobody finds
 * out until a consumer breaks.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coverageProblems,
  diffSnapshots,
  missingFromReport,
  normalizeDeclarationText,
  resolveSubpathEntryPoints,
  type Snapshot,
} from '../scripts/subpath-api-surface-rule.ts';

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = join(SDK_ROOT, 'packages', 'sdk');

const alwaysExists = (): boolean => true;
const neverExists = (): boolean => false;

describe('resolveSubpathEntryPoints', () => {
  test('a well-formed types condition resolves and reports no problem', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/email': { types: './dist/platform/email/index.d.ts', import: './x.js' } } },
      PACKAGE_DIR,
      alwaysExists,
    );
    expect(result.problems).toEqual([]);
    expect(result.entryPoints.get('./platform/email')).toBe(
      join(PACKAGE_DIR, 'dist', 'platform', 'email', 'index.d.ts'),
    );
  });

  test('a subpath with no types condition FAILS instead of being skipped', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/newthing': { import: './dist/platform/newthing/index.js' } } },
      PACKAGE_DIR,
      alwaysExists,
    );
    expect(result.entryPoints.size).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('./platform/newthing');
    expect(result.problems[0]).toContain('no "types" condition');
  });

  test('a types path that does not exist FAILS instead of recording an empty surface', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/email': { types: './dist/platform/email/index.d.ts' } } },
      PACKAGE_DIR,
      neverExists,
    );
    expect(result.entryPoints.size).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('does not exist');
  });

  test('published .json assets are not treated as type entry points', () => {
    const result = resolveSubpathEntryPoints(
      {
        exports: {
          './package.json': './package.json',
          './contracts/peer-contract.json': './dist/contracts/artifacts/peer-contract.json',
        },
      },
      PACKAGE_DIR,
      neverExists,
    );
    expect(result.problems).toEqual([]);
    expect(result.entryPoints.size).toBe(0);
  });

  test('a non-object, non-asset export entry FAILS', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/email': './dist/platform/email/index.js' } },
      PACKAGE_DIR,
      alwaysExists,
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('not a conditions object');
  });
});

describe('coverageProblems', () => {
  test('a subpath that exports something is accepted', () => {
    expect(coverageProblems({ './platform/email': [{ name: 'EmailSummary', kind: 'interface', text: 'x' }] })).toEqual([]);
  });

  test('a subpath that resolved to nothing is REJECTED', () => {
    const problems = coverageProblems({ './platform/email': [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exports nothing');
  });

  test('the allowlist can excuse an empty subpath, and only that subpath', () => {
    const allow = new Map([['./platform/empty', 'documented reason']]);
    expect(coverageProblems({ './platform/empty': [] }, allow)).toEqual([]);
    expect(coverageProblems({ './platform/other': [] }, allow)).toHaveLength(1);
  });
});

describe('missingFromReport', () => {
  const entries: Snapshot = { './platform/email': [{ name: 'EmailSummary', kind: 'interface', text: 'x' }] };

  test('a subpath already in the report is accepted', () => {
    expect(missingFromReport(new Map([['./platform/email', '/x.d.ts']]), entries)).toEqual([]);
  });

  test('a newly published subpath absent from the report is REJECTED', () => {
    const problems = missingFromReport(
      new Map([['./platform/email', '/x.d.ts'], ['./platform/newthing', '/y.d.ts']]),
      entries,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('./platform/newthing');
  });
});

describe('diffSnapshots', () => {
  const base: Snapshot = {
    './platform/email': [
      { name: 'EmailSummary', kind: 'interface', required: ['subject', 'uid'], text: 'interface EmailSummary { readonly subject: string; readonly uid: number; }' },
    ],
  };

  test('an unchanged surface produces no findings — the gate can answer NO', () => {
    expect(diffSnapshots(base, structuredClone(base))).toEqual([]);
  });

  test('a member TYPE change is reported, though names and required members are identical', () => {
    const after: Snapshot = {
      './platform/email': [
        { name: 'EmailSummary', kind: 'interface', required: ['subject', 'uid'], text: 'interface EmailSummary { readonly subject: string | null; readonly uid: number; }' },
      ],
    };
    const lines = diffSnapshots(base, after);
    expect(lines.some((line) => line.includes('declaration changed'))).toBe(true);
    // The name-and-required-members projection is identical across these two,
    // which is exactly why the previous version of this gate passed on it.
    expect(base['platform/email']).toBeUndefined();
    expect(after['./platform/email']?.[0]?.required).toEqual(base['./platform/email']?.[0]?.required ?? []);
  });

  test('a new REQUIRED member is called out as consumer-breaking', () => {
    const after: Snapshot = {
      './platform/email': [
        { name: 'EmailSummary', kind: 'interface', required: ['subject', 'uid', 'urgent'], text: 'interface EmailSummary { readonly subject: string; readonly uid: number; readonly urgent: boolean; }' },
      ],
    };
    const lines = diffSnapshots(base, after);
    expect(lines.some((line) => line.includes('gained REQUIRED member(s): urgent'))).toBe(true);
  });

  test('an added export and a removed export are both reported', () => {
    const added = diffSnapshots(base, {
      './platform/email': [
        ...base['./platform/email'] ?? [],
        { name: 'EmailDigest', kind: 'interface', text: 'interface EmailDigest {}' },
      ],
    });
    expect(added.some((line) => line.startsWith('  + ./platform/email exports interface EmailDigest'))).toBe(true);

    const removed = diffSnapshots(base, { './platform/email': [] });
    expect(removed.some((line) => line.includes('no longer exports EmailSummary'))).toBe(true);
  });
});

describe('normalizeDeclarationText', () => {
  test('strips block comments so a doc-only edit does not churn the report', () => {
    expect(normalizeDeclarationText('interface A {\n  /** the uid */\n  uid: number;\n}'))
      .toBe('interface A { uid: number; }');
  });

  test('leaves // inside a string literal type intact', () => {
    expect(normalizeDeclarationText("type U = 'https://example.test/x';"))
      .toBe("type U = 'https://example.test/x';");
  });

  test('two declarations differing only in a member type do not normalize to the same string', () => {
    expect(normalizeDeclarationText('interface A { s: string; }'))
      .not.toBe(normalizeDeclarationText('interface A { s: number; }'));
  });
});

describe('the committed report', () => {
  const committed = JSON.parse(readFileSync(join(SDK_ROOT, 'etc', 'subpath-api-surface.json'), 'utf8')) as Snapshot;
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };

  test('every subpath that publishes types has a non-empty section', () => {
    const { entryPoints, problems } = resolveSubpathEntryPoints(manifest, PACKAGE_DIR);
    expect(problems).toEqual([]);
    expect(missingFromReport(entryPoints, committed)).toEqual([]);
    expect(coverageProblems(committed)).toEqual([]);
    expect(entryPoints.size).toBeGreaterThan(100);
  });

  test('the platform email module is in the report with its declaration text', () => {
    const email = committed['./platform/email'] ?? [];
    for (const name of ['EmailInboxListResult', 'EmailSummary', 'ImapMessageDetail']) {
      const entry = email.find((candidate) => candidate.name === name);
      expect(entry, `${name} missing from ./platform/email`).toBeDefined();
      expect(entry?.text.length ?? 0).toBeGreaterThan(name.length);
    }
  });

  test('those same names are absent from the api-extractor rollups — the rollups are not this gate', () => {
    const rollup = readFileSync(join(SDK_ROOT, 'etc', 'goodvibes-sdk.api.md'), 'utf8')
      + readFileSync(join(SDK_ROOT, 'etc', 'goodvibes-sdk-embed.api.md'), 'utf8');
    // If this ever fails it is good news — it means `packages/sdk/src/index.ts`
    // started re-exporting the platform tree and the rollup covers it too. Fix
    // by deleting this assertion, not by narrowing the report.
    expect(rollup).not.toContain('EmailInboxListResult');
  });
});
