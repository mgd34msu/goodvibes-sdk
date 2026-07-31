import { describe, expect, test } from 'bun:test';
import { parseGoodVibesCli } from '@pellux/goodvibes-terminal-shell';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(args: string[]) {
  return parseGoodVibesCli(args, 'goodvibes');
}

function flags(args: string[]) {
  return parse(args).flags;
}

// ---------------------------------------------------------------------------
// --continue
// ---------------------------------------------------------------------------

describe('--continue flag', () => {
  test('sets continueLast=true', () => {
    expect(flags(['--continue']).continueLast).toBe(true);
  });

  test('continueLast defaults to false', () => {
    expect(flags([]).continueLast).toBe(false);
  });

  test('--continue alongside --model parses both', () => {
    const f = flags(['--continue', '--model', 'openai:gpt-5.2']);
    expect(f.continueLast).toBe(true);
    expect(f.model).toBe('openai:gpt-5.2');
  });

  test('--continue does not affect command (stays tui)', () => {
    const result = parse(['--continue']);
    expect(result.command).toBe('tui');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --resume [id]
// ---------------------------------------------------------------------------

describe('--resume flag', () => {
  test('bare --resume sets resume="latest"', () => {
    expect(flags(['--resume']).resume).toBe('latest');
  });

  test('--resume with explicit id sets that id', () => {
    expect(flags(['--resume', 'session-abc123']).resume).toBe('session-abc123');
  });

  test('-r bare sets resume="latest"', () => {
    expect(flags(['-r']).resume).toBe('latest');
  });

  test('-r with explicit id sets that id', () => {
    expect(flags(['-r', 'sess-xyz']).resume).toBe('sess-xyz');
  });

  test('--resume=<id> inline value parses correctly', () => {
    expect(flags(['--resume=user-1234']).resume).toBe('user-1234');
  });

  test('resume defaults to undefined', () => {
    expect(flags([]).resume).toBeUndefined();
  });

  test('--resume does not affect command (stays tui)', () => {
    const result = parse(['--resume']);
    expect(result.command).toBe('tui');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --fork [id]
// ---------------------------------------------------------------------------

describe('--fork flag', () => {
  test('bare --fork sets fork=true (no sentinel string collision)', () => {
    expect(flags(['--fork']).fork).toBe(true);
  });

  test('--fork with explicit session id sets that id', () => {
    expect(flags(['--fork', 'user-sess-1234']).fork).toBe('user-sess-1234');
  });

  test('--fork=<id> inline value parses correctly', () => {
    expect(flags(['--fork=session-xyz']).fork).toBe('session-xyz');
  });

  test('fork defaults to undefined (not false, not empty string)', () => {
    expect(flags([]).fork).toBeUndefined();
  });

  test('--fork current forks the session named "current" by explicit id (no sentinel collision)', () => {
    // With the boolean-union type, bare --fork → true; "current" as an explicit id stays a string
    expect(flags(['--fork', 'current']).fork).toBe('current');
    expect(flags(['--fork', 'current']).fork).not.toBe(true);
  });

  test('bare --fork is true, not the string "current"', () => {
    const f = flags(['--fork']);
    expect(f.fork).toBe(true);
    expect(f.fork).not.toBe('current');
  });

  test('--fork does not affect command (stays tui)', () => {
    const result = parse(['--fork']);
    expect(result.command).toBe('tui');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --yes / -y
// ---------------------------------------------------------------------------

describe('--yes / -y flag', () => {
  test('--yes sets yes=true', () => {
    expect(flags(['--yes']).yes).toBe(true);
  });

  test('-y sets yes=true', () => {
    expect(flags(['-y']).yes).toBe(true);
  });

  test('yes defaults to false', () => {
    expect(flags([]).yes).toBe(false);
  });

  test('--yes alongside run command parses cleanly', () => {
    const result = parse(['run', '--yes', 'do something']);
    expect(result.flags.yes).toBe(true);
    expect(result.command).toBe('run');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --non-interactive
// ---------------------------------------------------------------------------

describe('--non-interactive flag', () => {
  test('--non-interactive sets nonInteractive=true', () => {
    expect(flags(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('nonInteractive defaults to false', () => {
    expect(flags([]).nonInteractive).toBe(false);
  });

  test('--non-interactive and --yes can coexist', () => {
    const f = flags(['--non-interactive', '--yes']);
    expect(f.nonInteractive).toBe(true);
    expect(f.yes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --strict (doctor)
// ---------------------------------------------------------------------------

describe('--strict flag', () => {
  test('--strict sets strict=true', () => {
    expect(flags(['--strict']).strict).toBe(true);
  });

  test('strict defaults to false', () => {
    expect(flags([]).strict).toBe(false);
  });

  test('doctor --strict parses cleanly', () => {
    const result = parse(['doctor', '--strict']);
    expect(result.command).toBe('doctor');
    expect(result.flags.strict).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Output flag alias consolidation
// Canonical: --output / -o
// Aliases: --output-format (deprecated alias), --json (shorthand)
// Conflict resolution: last-wins (left-to-right token processing)
// ---------------------------------------------------------------------------

describe('output flag consolidation', () => {
  test('--output sets canonical outputFormat', () => {
    expect(flags(['--output', 'json']).outputFormat).toBe('json');
  });

  test('-o sets canonical outputFormat', () => {
    expect(flags(['-o', 'stream-json']).outputFormat).toBe('stream-json');
  });

  test('--output-format (alias) maps onto outputFormat', () => {
    expect(flags(['--output-format', 'json']).outputFormat).toBe('json');
  });

  test('--json (alias) maps onto outputFormat=json', () => {
    expect(flags(['--json']).outputFormat).toBe('json');
  });

  test('all three valid output values are accepted', () => {
    for (const fmt of ['text', 'json', 'stream-json'] as const) {
      expect(flags(['--output', fmt]).outputFormat).toBe(fmt);
    }
  });

  test('invalid --output value emits error with canonical flag name', () => {
    const result = parse(['--output', 'yaml']);
    expect(result.errors).toContain('--output must be one of: text, json, stream-json.');
    expect(result.flags.outputFormat).toBe('text');
  });

  test('invalid --output-format value emits error with alias flag name', () => {
    const result = parse(['--output-format', 'yaml']);
    expect(result.errors).toContain('--output-format must be one of: text, json, stream-json.');
    expect(result.flags.outputFormat).toBe('text');
  });

  // Conflict resolution: last-wins semantics
  test('--json then --output stream-json → stream-json (last wins)', () => {
    expect(flags(['--json', '--output', 'stream-json']).outputFormat).toBe('stream-json');
  });

  test('--output text then --json → json (last wins)', () => {
    expect(flags(['--output', 'text', '--json']).outputFormat).toBe('json');
  });

  test('--output-format json then --output stream-json → stream-json (last wins)', () => {
    expect(flags(['--output-format', 'json', '--output', 'stream-json']).outputFormat).toBe('stream-json');
  });

  test('--output json then --output-format text → text (last wins)', () => {
    expect(flags(['--output', 'json', '--output-format', 'text']).outputFormat).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// --hostname / --host alias consolidation
// Canonical: --hostname (documented in help as --hostname; --host is an alias)
// Both map to the same flags.hostname field
// ---------------------------------------------------------------------------

describe('hostname flag consolidation', () => {
  test('--hostname maps to flags.hostname', () => {
    expect(flags(['--hostname', '0.0.0.0']).hostname).toBe('0.0.0.0');
  });

  test('--host maps to flags.hostname', () => {
    expect(flags(['--host', '127.0.0.1']).hostname).toBe('127.0.0.1');
  });

  test('--hostname=<value> inline value works', () => {
    expect(flags(['--hostname=example.local']).hostname).toBe('example.local');
  });

  test('--host=<value> inline value works', () => {
    expect(flags(['--host=192.168.1.1']).hostname).toBe('192.168.1.1');
  });

  test('hostname defaults to undefined', () => {
    expect(flags([]).hostname).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session flags coexistence
// ---------------------------------------------------------------------------

describe('session flags coexistence', () => {
  test('--continue and --model can coexist', () => {
    const f = flags(['--continue', '--model', 'anthropic:claude-sonnet-4-6']);
    expect(f.continueLast).toBe(true);
    expect(f.model).toBe('anthropic:claude-sonnet-4-6');
    expect(f.provider).toBe('anthropic');
  });

  test('--resume and --yes can coexist', () => {
    const f = flags(['--resume', 'sess-abc', '--yes']);
    expect(f.resume).toBe('sess-abc');
    expect(f.yes).toBe(true);
  });

  test('--fork and --provider can coexist', () => {
    const f = flags(['--fork', 'sess-xyz', '--provider', 'openai']);
    expect(f.fork).toBe('sess-xyz');
    expect(f.provider).toBe('openai');
  });

  test('--continue and --resume together produce a conflict error', () => {
    const result = parse(['--continue', '--resume', 'sess-1']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--continue') && e.includes('--resume'))).toBe(true);
  });

  test('--continue and --fork together produce a conflict error', () => {
    const result = parse(['--continue', '--fork', 'sess-2']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--continue') && e.includes('--fork'))).toBe(true);
  });

  test('--resume and --fork together produce a conflict error', () => {
    const result = parse(['--resume', 'sess-1', '--fork', 'sess-2']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--resume') && e.includes('--fork'))).toBe(true);
  });

  test('all three lifecycle flags together produce a conflict error listing all three', () => {
    const result = parse(['--continue', '--resume', 'sess-1', '--fork', 'sess-2']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--continue') && e.includes('--resume') && e.includes('--fork'))).toBe(true);
  });

  test('session lifecycle flags can coexist with non-lifecycle flags without conflict errors', () => {
    // --yes and --non-interactive do not conflict with lifecycle flags
    const result = parse(['--continue', '--yes', '--non-interactive']);
    expect(result.errors.filter((e) => e.includes('Conflicting'))).toHaveLength(0);
    expect(result.flags.continueLast).toBe(true);
    expect(result.flags.yes).toBe(true);
    expect(result.flags.nonInteractive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --continue is a pure parse-time flag
//
// Pointer-file resolution (reading a front-end's last-session pointer off
// disk) is a startup-time concern that lives in each front-end's own runtime
// wiring, not in this parser: parseGoodVibesCli never touches the filesystem.
// ---------------------------------------------------------------------------

describe('--continue is a pure parse-time flag', () => {
  test('--continue flag parses without error (pointer lookup happens at startup, not parse time)', () => {
    const result = parse(['--continue']);
    expect(result.errors).toEqual([]);
    expect(result.flags.continueLast).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// -y bypass wiring: --yes flag is parsed and present on flags for callers
// ---------------------------------------------------------------------------

describe('-y / --yes bypass availability', () => {
  test('--yes flag is present on the flags object for bypass wiring', () => {
    // --yes is a global flag — after the command is consumed, remaining tokens go to commandArgs
    // The key invariant: yes=true when the global flag is set before the command
    const global = parse(['--yes', 'sessions', 'list']);
    expect(global.flags.yes).toBe(true);
    expect(global.command).toBe('sessions');
    expect(global.errors).toEqual([]);
  });

  test('-y is a short alias for --yes', () => {
    const result = parse(['-y', 'secrets', 'delete', 'MY_KEY']);
    expect(result.flags.yes).toBe(true);
    expect(result.command).toBe('secrets');
    expect(result.errors).toEqual([]);
  });

  test('--non-interactive flag is present on the flags object for bypass wiring', () => {
    const result = parse(['--non-interactive', 'run', 'do something']);
    expect(result.flags.nonInteractive).toBe(true);
    expect(result.command).toBe('run');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Positional/refusal semantics the catalog engine has to reproduce exactly.
//
// Each of these was measured against the terminal's own hand-written parser
// over 60,000 generated command lines; the engine now answers identically on
// every one of them. They are pinned individually because each is a different
// mechanism and a regression in any of them is silent at the call site.
// ---------------------------------------------------------------------------

describe('command-word resolution', () => {
  test('a later word still names the command when an earlier one does not', () => {
    const result = parse(['foo', 'web']);
    expect(result.command).toBe('web');
    expect(result.rawCommand).toBe('web');
    // The stray word is a positional of the invocation, not an argument the
    // command was handed.
    expect(result.positionals).toEqual(['foo']);
    expect(result.commandArgs).toEqual([]);
  });

  test('only tokens AFTER the command word become that command’s arguments', () => {
    const result = parse(['a.txt', 'serve', 'b.txt']);
    expect(result.command).toBe('serve');
    expect(result.positionals).toEqual(['a.txt', 'b.txt']);
    expect(result.commandArgs).toEqual(['b.txt']);
  });

  test('a command word after `--` is not a command word', () => {
    const result = parse(['--', 'web']);
    expect(result.command).toBe('tui');
    expect(result.positionals).toEqual(['web']);
  });
});

describe('unknown flags', () => {
  test('an unknown flag typed BEFORE the command word is still refused', () => {
    const result = parse(['--typo-flag', 'status']);
    expect(result.command).toBe('status');
    expect(result.errors[0]).toContain('Unknown option: --typo-flag');
    expect(result.commandArgs).toEqual([]);
  });

  test('an unknown flag typed after the command word rides that command’s leniency', () => {
    const result = parse(['status', '--typo-flag']);
    expect(result.errors).toEqual([]);
    expect(result.commandArgs).toEqual(['--typo-flag']);
  });
});

describe('missing flag values', () => {
  test('a required value that is not there does not eat the next flag', () => {
    const result = parse(['--daemon-home', '--model', 'surfaces']);
    // `surfaces` is --model's value, so nothing is left to name a command.
    expect(result.command).toBe('tui');
    expect(result.flags.model).toBe('surfaces');
    expect(result.errors).toEqual(['--daemon-home requires a value.']);
  });

  test('a defaulted enum with no value states its choices and falls back', () => {
    const result = parse(['--json', '--output-format']);
    expect(result.flags.outputFormat).toBe('text');
    expect(result.errors).toEqual([
      '--output-format requires a value.',
      '--output-format must be one of: text, json, stream-json.',
    ]);
  });
});

describe('a bare `-`', () => {
  test('is not swallowed as an optional flag’s value', () => {
    expect(flags(['--fork', '-']).fork).toBe(true);
    expect(flags(['--resume', '-']).resume).toBe('latest');
    expect(parse(['--resume', '-']).positionals).toEqual(['-']);
  });

  test('is still accepted where a value is required', () => {
    expect(flags(['--session', '-']).session).toBe('-');
  });
});
