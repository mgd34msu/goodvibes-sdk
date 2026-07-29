/**
 * bun-pin-agreement.test.ts
 *
 * The repository declares its bun version in twenty-three places. One of them
 * carries a FLOOR with a reason behind it: bun 1.3.10 through 1.3.13 deadlock
 * the module loader once a process has closed two or more `node:fs` watch
 * handles, and the next module graph the loader fetches never resolves — an
 * idle event loop, no output, and nothing to notice it until something outside
 * the process runs out of patience. It cost two fifteen-minute CI cycles of
 * silence before it was found.
 *
 * A floor is only as strong as the weakest copy of the number, so
 * `scripts/bun-pin-rule.ts` holds every copy to the root `engines.bun`. These
 * cases are the ones that decide whether it can actually catch a stale copy:
 * both YAML shapes, the block scoping that keeps an unrelated `default:` out of
 * it, and the live repository itself.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBunPins, collectBunPins, isExactVersion } from '../scripts/bun-pin-rule.ts';

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(readFileSync(resolve(SDK_ROOT, 'package.json'), 'utf8')) as {
  packageManager: string;
  engines: { bun: string };
  devDependencies: Record<string, string>;
};

describe('the two shapes a bun pin takes in GitHub Actions YAML', () => {
  test('an inline `bun-version:` value is a pin', () => {
    const pins = collectBunPins({
      relPath: 'w.yml',
      text: ['jobs:', '  a:', '    with:', '      bun-version: "1.3.14"'].join('\n'),
    });
    expect(pins).toHaveLength(1);
    expect(pins[0]?.version).toBe('1.3.14');
    expect(pins[0]?.kind).toBe('bun-version');
    expect(pins[0]?.line).toBe(4);
  });

  test('an unquoted inline value is a pin too', () => {
    const pins = collectBunPins({ relPath: 'w.yml', text: '          bun-version: 1.3.14' });
    expect(pins).toHaveLength(1);
    expect(pins[0]?.version).toBe('1.3.14');
  });

  test('the `default:` inside a `bun-version:` input block is a pin', () => {
    const pins = collectBunPins({
      relPath: 'r.yml',
      text: [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      bun-version:',
        '        required: false',
        '        type: string',
        '        default: "1.3.14"',
      ].join('\n'),
    });
    expect(pins).toHaveLength(1);
    expect(pins[0]?.version).toBe('1.3.14');
    expect(pins[0]?.kind).toBe('bun-version-default');
    expect(pins[0]?.line).toBe(7);
  });

  test('a `default:` belonging to the NEXT input is not read as bun\'s', () => {
    // The block ends at the first line indented no deeper than the key, so
    // node-version's default cannot be mistaken for the bun pin. Without that
    // scoping this fixture would report 22.16.5 as a bun version.
    const pins = collectBunPins({
      relPath: 'r.yml',
      text: [
        '    inputs:',
        '      bun-version:',
        '        required: false',
        '      node-version:',
        '        default: "22.16.5"',
      ].join('\n'),
    });
    expect(pins).toEqual([]);
  });

  test('a commented-out pin is not a pin', () => {
    const pins = collectBunPins({ relPath: 'w.yml', text: '      # bun-version: 1.3.10' });
    expect(pins).toEqual([]);
  });

  test('prose that merely mentions a version is not a pin', () => {
    const pins = collectBunPins({
      relPath: 'a.yml',
      text: '# Bun 1.3.10 through 1.3.13 deadlock the module loader.',
    });
    expect(pins).toEqual([]);
  });
});

describe('disagreement is reported with the file, the line and the expected value', () => {
  test('a stale pin fails and names where it is', () => {
    const violations = checkBunPins('1.3.14', [
      { relPath: '.github/workflows/w.yml', text: '\n      bun-version: "1.3.10"' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('.github/workflows/w.yml:2');
    expect(violations[0]).toContain('1.3.10');
    expect(violations[0]).toContain('1.3.14');
  });

  test('a matching pin is silent', () => {
    expect(checkBunPins('1.3.14', [{ relPath: 'w.yml', text: '      bun-version: "1.3.14"' }])).toEqual([]);
  });

  test('every stale pin is reported, not just the first', () => {
    const violations = checkBunPins('1.3.14', [
      { relPath: 'a.yml', text: '      bun-version: "1.3.10"' },
      { relPath: 'b.yml', text: '      bun-version: "1.3.13"' },
    ]);
    expect(violations).toHaveLength(2);
  });

  test('a range is not an acceptable source of truth', () => {
    expect(isExactVersion('^1.3.14')).toBe(false);
    expect(isExactVersion('1.3.14')).toBe(true);
    expect(checkBunPins('^1.3.14', [])[0]).toContain('exact version');
  });
});

describe('the live repository', () => {
  test('engines.bun is an exact version at or above the 1.3.14 floor', () => {
    const declared = rootPackage.engines.bun;
    expect(isExactVersion(declared)).toBe(true);
    const [major, minor, patch] = declared.split('.').map(Number) as [number, number, number];
    // Bun 1.3.10-1.3.13 deadlock the module loader after two fs.watch closes;
    // 1.3.13 still reproduced it 6 times in 12 runs. 1.3.14 is the floor.
    const atOrAboveFloor = major > 1
      || (major === 1 && minor > 3)
      || (major === 1 && minor === 3 && patch >= 14);
    expect(atOrAboveFloor, `bun ${declared} is below the 1.3.14 module-loader floor`).toBe(true);
  });

  test('packageManager and @types/bun agree with engines.bun', () => {
    expect(rootPackage.packageManager).toBe(`bun@${rootPackage.engines.bun}`);
    expect(rootPackage.devDependencies['@types/bun']).toBe(rootPackage.engines.bun);
  });
});
