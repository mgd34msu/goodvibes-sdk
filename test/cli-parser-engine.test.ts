/**
 * cli-parser-engine.test.ts, the generic engine's own contract, independent
 * of any one product's vocabulary.
 *
 * Two things are pinned here that `cli-parser.test.ts` (the TUI vocabulary's
 * own ported suite) cannot exercise, because the TUI catalog deliberately
 * opts OUT of both to preserve its exact current behavior:
 *
 *   1. a catalog CAN make an unmatched first token a hard refusal
 *      (`unmatchedFirstToken: 'reject'`), the capability a daemon-shaped
 *      vocabulary needs and the TUI vocabulary declines.
 *   2. a catalog's own flag-token arity is self-consistent, the same check
 *      the daemon's `findCatalogFlagArityConflicts` runs against its own
 *      data, run here against the real GOODVIBES_CLI_CATALOG.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseWithCatalog,
  findCatalogFlagArityConflicts,
  type CliCatalog,
} from '@pellux/goodvibes-terminal-shell';
import { GOODVIBES_CLI_CATALOG } from '@pellux/goodvibes-terminal-shell';

type TestCommand = 'run' | 'status';
type TestField = 'help' | 'verbose' | 'name';
interface TestFlags {
  readonly help: boolean;
  readonly verbose: boolean;
  readonly name: string | undefined;
}

function rejectingCatalog(): CliCatalog<TestCommand, TestField, TestFlags> {
  return {
    commands: [
      { name: 'run', aliases: [], flags: [], passthrough: false, subcommands: [] },
      {
        name: 'status',
        aliases: [],
        flags: [{ tokens: ['--name'], field: 'name', kind: 'string', summary: 'A name.' }],
        passthrough: false,
        subcommands: [],
      },
    ],
    globalFlags: [
      { tokens: ['--help'], field: 'help', kind: 'boolean', summary: 'Help.' },
      { tokens: ['--verbose'], field: 'verbose', kind: 'boolean', summary: 'Verbose.' },
    ],
    defaultCommand: 'run',
    unmatchedFirstToken: 'reject',
    createDefaultFlags: () => ({ help: false, verbose: false, name: undefined }),
  };
}

describe('unmatchedFirstToken: reject', () => {
  test('an unrecognized first word is refused by name rather than becoming a positional', () => {
    const result = parseWithCatalog(['frobnicate'], rejectingCatalog(), 'test-cli');
    expect(result.errors).toContain('Unknown command: frobnicate');
    expect(result.commandArgs).toEqual([]);
    expect(result.positionals).toEqual([]);
  });

  test('a recognized command still parses normally', () => {
    const result = parseWithCatalog(['status', '--name', 'workshop'], rejectingCatalog(), 'test-cli');
    expect(result.errors).toEqual([]);
    expect(result.command).toBe('status');
    expect(result.flags.name).toBe('workshop');
  });

  test('the sentinel command is configurable, defaulting to defaultCommand', () => {
    const catalog: CliCatalog<TestCommand, TestField, TestFlags> = {
      ...rejectingCatalog(),
      unresolvedCommandSentinel: 'status',
    };
    const result = parseWithCatalog(['nope'], catalog, 'test-cli');
    expect(result.command).toBe('status');
  });
});

describe('unmatchedFirstToken: passthrough (the TUI vocabulary\'s choice)', () => {
  test('an unrecognized first word is silently a positional, not a refusal', () => {
    // Proves the capability above is genuinely opt-in: the same engine, given
    // a lenient catalog, produces the TUI's exact current behavior instead.
    const catalog: CliCatalog<TestCommand, TestField, TestFlags> = {
      ...rejectingCatalog(),
      unmatchedFirstToken: 'passthrough',
    };
    const result = parseWithCatalog(['frobnicate'], catalog, 'test-cli');
    expect(result.errors).toEqual([]);
    expect(result.command).toBe('run');
    expect(result.positionals).toEqual(['frobnicate']);
  });
});

describe('findCatalogFlagArityConflicts', () => {
  test('detects a token declared with two different kinds', () => {
    const catalog: CliCatalog<TestCommand, TestField, TestFlags> = {
      ...rejectingCatalog(),
      commands: [
        {
          name: 'run',
          aliases: [],
          flags: [{ tokens: ['--verbose'], field: 'name', kind: 'string', summary: 'conflicting' }],
          passthrough: false,
          subcommands: [],
        },
        { name: 'status', aliases: [], flags: [], passthrough: false, subcommands: [] },
      ],
    };
    const conflicts = findCatalogFlagArityConflicts(catalog);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('--verbose');
    expect(conflicts[0]).toContain('boolean');
    expect(conflicts[0]).toContain('string');
  });

  test('the real GOODVIBES_CLI_CATALOG is internally consistent', () => {
    expect(findCatalogFlagArityConflicts(GOODVIBES_CLI_CATALOG)).toEqual([]);
  });
});
