import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

import type { Config } from '../vendor/bash-language-server/out/config.js';
import type { ShellCheckComment } from '../vendor/bash-language-server/out/shellcheck/types.js';

// Resolve through the SDK, not the monorepo root: the vendor has an exact Zod
// dependency and must not accidentally exercise the workspace's hoisted copy.
const sdkRequire = createRequire(new URL('../packages/sdk/package.json', import.meta.url));
const vendorRequire = createRequire(sdkRequire.resolve('bash-language-server/package.json'));
const { ConfigSchema, getDefaultConfiguration } = vendorRequire('./out/config.js') as typeof import('../vendor/bash-language-server/out/config.js');
const { ShellCheckResultSchema } = vendorRequire('./out/shellcheck/types.js') as typeof import('../vendor/bash-language-server/out/shellcheck/types.js');
const { z } = vendorRequire('zod') as typeof import('zod');

const defaultShfmt = {
  path: 'shfmt',
  ignoreEditorconfig: false,
  languageDialect: 'auto',
  binaryNextLine: false,
  caseIndent: false,
  funcNextLine: false,
  keepPadding: false,
  simplifyCode: false,
  spaceRedirects: false,
} satisfies Config['shfmt'];

const comment = {
  file: 'example.sh',
  line: 1,
  endLine: 1,
  column: 6,
  endColumn: 11,
  level: 'info',
  code: 2086,
  message: 'Double quote to prevent globbing and word splitting.',
  fix: null,
} satisfies ShellCheckComment;

describe('vendored Bash LSP Zod 4 compatibility', () => {
  test('uses its patched Zod dependency, independently of the workspace root', () => {
    expect(vendorRequire('./package.json').dependencies.zod).toBe('4.6.6');
    expect(vendorRequire('zod/package.json').version).toBe('4.6.6');
  });

  test('preserves all defaults, including nested shfmt defaults when omitted', () => {
    expect(getDefaultConfiguration()).toEqual({
      backgroundAnalysisMaxFiles: 500,
      enableSourceErrorDiagnostics: false,
      globPattern: '**/*@(.sh|.inc|.bash|.command)',
      explainshellEndpoint: '',
      logLevel: 'info',
      includeAllWorkspaceSymbols: false,
      shellcheckArguments: [],
      shellcheckPath: 'shellcheck',
      shfmt: defaultShfmt,
    });
    expect(ConfigSchema.parse({ shfmt: {} }).shfmt).toEqual(defaultShfmt);
    expect(ConfigSchema.parse({ shfmt: { path: '', binaryNextLine: true } }).shfmt)
      .toEqual({ ...defaultShfmt, path: '', binaryNextLine: true });
  });

  test('retains argument preprocessing, trimming, optional overrides and unknown-key stripping', () => {
    const config = ConfigSchema.parse({
      shellcheckArguments: '  --external-sources   --severity=warning ',
      shellcheckPath: ' /usr/bin/shellcheck ',
      globPattern: ' *.bash ',
      unknownSetting: true,
      shfmt: { languageDialect: 'bash', unknownSetting: true },
    });
    expect(config.shellcheckArguments).toEqual(['--external-sources', '--severity=warning']);
    expect(config.shellcheckPath).toBe('/usr/bin/shellcheck');
    expect(config.globPattern).toBe('*.bash');
    expect(config.shfmt).toEqual({ ...defaultShfmt, languageDialect: 'bash' });
    expect(config).not.toHaveProperty('unknownSetting');
    expect(ConfigSchema.parse({ shellcheckArguments: [' -x ', '', ' --severity=warning '] }).shellcheckArguments)
      .toEqual(['-x', '--severity=warning']);
  });

  test('rejects invalid configuration rather than silently accepting malformed values', () => {
    for (const input of [
      { backgroundAnalysisMaxFiles: -1 },
      { backgroundAnalysisMaxFiles: 1.5 },
      { enableSourceErrorDiagnostics: 'true' },
      { logLevel: 'verbose' },
      { shfmt: { languageDialect: 'fish' } },
      { shellcheckArguments: [12] },
    ]) {
      expect(() => ConfigSchema.parse(input)).toThrow();
    }
  });

  test('parses ShellCheck diagnostics with null fixes and replacement fixes', () => {
    const replacement = {
      precedence: 0,
      line: 1,
      endLine: 1,
      column: 6,
      endColumn: 11,
      insertionPoint: 'beforeStart',
      replacement: '"$name"',
    };
    const fixedComment = { ...comment, fix: { replacements: [replacement] } };
    expect(ShellCheckResultSchema.parse({ comments: [comment, fixedComment], extra: true }))
      .toEqual({ comments: [comment, fixedComment] });
    expect(ShellCheckResultSchema.parse({ comments: [] })).toEqual({ comments: [] });
  });

  test('rejects malformed ShellCheck diagnostic fields and replacement values', () => {
    expect(ShellCheckResultSchema.safeParse({ comments: [{ ...comment, level: 'fatal' }] }).success).toBe(false);
    expect(ShellCheckResultSchema.safeParse({ comments: [{ ...comment, line: '1' }] }).success).toBe(false);
    expect(ShellCheckResultSchema.safeParse({ comments: [{ ...comment, fix: { replacements: [{}] } }] }).success).toBe(false);
  });

  test('rejects oversized constrained collections before parsing their elements', () => {
    let parsedElements = 0;
    const schema = z.array(z.string().refine(() => { parsedElements += 1; return true; })).max(1);
    const result = schema.safeParse(['first', 'second']);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe('too_big');
    }
    expect(parsedElements).toBe(0);
  });
});
