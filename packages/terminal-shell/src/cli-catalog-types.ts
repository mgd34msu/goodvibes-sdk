/**
 * cli-catalog-types.ts — the generic argument-parsing engine's catalog
 * contract: what a product declares to get argv parsing, independent of which
 * commands or flags it has.
 *
 * A daemon-shaped front-end and a terminal-shaped front-end need DIFFERENT
 * command vocabularies over the SAME parsing mechanics: tokens, values,
 * arity, `--`, and refusals. This file is the seam between them — it holds no
 * product's commands or flags, only the SHAPE a catalog takes. See
 * cli-parser-engine.ts for the engine that reads a `CliCatalog<TCommand,
 * TField, TFlags>` and produces an `EngineParseResult`, and
 * cli-command-catalog.ts for this package's own instance (the shared
 * terminal front-end vocabulary `parseGoodVibesCli` is built from).
 */

/**
 * How a flag consumes argv, and what shape its value has.
 *
 * `boolean` / `string` / `port` / `string-list` match a daemon-shaped
 * catalog's own flag kinds exactly. `string-optional`, `const`, and `enum`
 * are additive: a terminal front-end's vocabulary needs a flag that MAY take
 * a value (`--resume [id]`), a flag that assigns a fixed value to a field it
 * shares with another flag (`--json` on the same field `--output` writes),
 * and a flag whose value is checked against a fixed set. A catalog that never
 * declares these three simply never exercises them — legal, unused kinds
 * cost it nothing.
 */
export type CliFlagKind = 'boolean' | 'string' | 'port' | 'string-list' | 'string-optional' | 'const' | 'enum';

/** Every legal value shape a flag's field can hold. */
export type CliFlagValue = string | number | boolean | readonly string[] | undefined;

export interface CommandFlagSpec<TField extends string> {
  /** Every spelling that selects this flag, longest-lived first. */
  readonly tokens: readonly string[];
  readonly field: TField;
  readonly kind: CliFlagKind;
  /** Placeholder shown in help for a value-taking flag. */
  readonly valueName?: string | undefined;
  readonly summary: string;
  /** `string-optional` only: the value applied when the flag has no following value. */
  readonly bareValue?: string | true | undefined;
  /** `const` only: the fixed value this flag's mere presence assigns to `field`. */
  readonly constValue?: CliFlagValue | undefined;
  /** `enum` only: the values a string value is checked against. */
  readonly enumValues?: readonly string[] | undefined;
  /** `enum` only: applied in place of an invalid value. */
  readonly enumDefault?: string | undefined;
  /** Pushed to `warnings` whenever this spec is matched — a deprecated alias's notice. */
  readonly warning?: string | undefined;
}

export interface CommandSpec<TCommand extends string, TField extends string> {
  readonly name: TCommand;
  /** Extra spellings that resolve to this command. The name itself is always accepted. */
  readonly aliases: readonly string[];
  /** One line, for a command list. Optional: a catalog with no help surface of its own may omit it. */
  readonly summary?: string | undefined;
  /** Argument shape, for a `help <command>` first line. Optional, same reason. */
  readonly usage?: string | undefined;
  /** The body of `help <command>`. Optional, same reason. */
  readonly detail?: readonly string[] | undefined;
  /** Flags this command accepts, beyond the catalog's global ones. */
  readonly flags: readonly CommandFlagSpec<TField>[];
  /**
   * True when everything from the command word onward belongs to the
   * command's own parser rather than to this one: no flag interpretation at
   * all past that point, not even the catalog's global flags — every
   * remaining token, flag-shaped or not, lands in `commandArgs` verbatim.
   */
  readonly passthrough: boolean;
  /**
   * When true (and `passthrough` is false), an option-shaped token that
   * matches no flag accepted here is pushed into `commandArgs` instead of
   * refused — the command's own downstream handler is trusted to interpret
   * it. Defaults to false: an unmatched option refuses, naming what this
   * command accepts.
   */
  readonly lenientUnknownFlags?: boolean | undefined;
  /** Positional words the command takes, for completion. Empty for most. */
  readonly subcommands: readonly string[];
}

/** A flag this catalog understands belongs to another surface entirely, refused by name. */
export interface RejectedFlagSpec {
  readonly reason: string;
  /** True when the flag took a value in whatever parser this one superseded. */
  readonly takesValue: boolean;
}

export interface CliCatalog<TCommand extends string, TField extends string, TFlags> {
  readonly commands: readonly CommandSpec<TCommand, TField>[];
  /** Accepted before or after any command, on every command that does not override the field. */
  readonly globalFlags: readonly CommandFlagSpec<TField>[];
  /** Flags a superseded parser accepted that this one refuses by name. */
  readonly rejectedFlags?: Readonly<Record<string, RejectedFlagSpec>> | undefined;
  /** The command a bare invocation resolves to. */
  readonly defaultCommand: TCommand;
  /**
   * What happens when the first non-flag token names no known command:
   * `'reject'` refuses it by name (the daemon-shaped answer — an unmatched
   * word must never quietly start the default command); `'passthrough'`
   * treats it as an ordinary positional under `defaultCommand`, silently (the
   * terminal-shaped answer, preserved for exact backward compatibility).
   */
  readonly unmatchedFirstToken: 'reject' | 'passthrough';
  /** The command reported in the parse result when `unmatchedFirstToken` is `'reject'`. Defaults to `defaultCommand`. */
  readonly unresolvedCommandSentinel?: TCommand | undefined;
  readonly createDefaultFlags: () => TFlags;
  /**
   * Final, whole-parse adjustments a catalog's own domain rules need — e.g.
   * folding leftover positionals into a prompt field, inferring one field
   * from another, or flagging a conflicting combination of flags. Absent for
   * a catalog with no such rules (there is nothing the daemon's own
   * vocabulary needs this for today).
   */
  readonly postProcess?: ((result: EngineParseResult<TCommand, TFlags>) => EngineParseResult<TCommand, TFlags>) | undefined;
}

export interface EngineParseResult<TCommand extends string, TFlags> {
  readonly binary: string;
  readonly command: TCommand;
  /** The word the operator actually typed, when a command word was resolved. */
  readonly rawCommand: string | undefined;
  /**
   * Everything after the command word that is not a flag this engine owns.
   * For a passthrough command it is every remaining token verbatim, flags
   * included.
   */
  readonly commandArgs: readonly string[];
  /** Every non-flag token seen, both before and after the command word. */
  readonly positionals: readonly string[];
  readonly flags: TFlags;
  /** Usage refusals. A non-empty list means the caller should exit non-zero. */
  readonly errors: readonly string[];
  /** Non-fatal notices — deprecation and soft warnings. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Catalog-wide lookups, generic over any CliCatalog.
// ---------------------------------------------------------------------------

/** Every flag token declared anywhere in the catalog, mapped to its arity kind. */
export function catalogFlagArity<TCommand extends string, TField extends string>(
  catalog: Pick<CliCatalog<TCommand, TField, unknown>, 'commands' | 'globalFlags'>,
): ReadonlyMap<string, CliFlagKind> {
  const table = new Map<string, CliFlagKind>();
  const record = (spec: CommandFlagSpec<TField>): void => {
    for (const token of spec.tokens) table.set(token, spec.kind);
  };
  for (const spec of catalog.globalFlags) record(spec);
  for (const command of catalog.commands) for (const spec of command.flags) record(spec);
  return table;
}

/** The catalog entry for a command, or throws — every catalog's own command union is exhaustive by construction. */
export function catalogCommandSpec<TCommand extends string, TField extends string>(
  catalog: Pick<CliCatalog<TCommand, TField, unknown>, 'commands'>,
  command: TCommand,
): CommandSpec<TCommand, TField> {
  const spec = catalog.commands.find((entry) => entry.name === command);
  if (!spec) throw new Error(`No catalog entry for command '${command}'`);
  return spec;
}

/** Resolve a raw argv word to a command, or undefined when it names none. */
export function resolveCatalogCommand<TCommand extends string, TField extends string>(
  catalog: Pick<CliCatalog<TCommand, TField, unknown>, 'commands'>,
  token: string,
): TCommand | undefined {
  const lower = token.toLowerCase();
  for (const spec of catalog.commands) {
    if (spec.name === lower || (spec.aliases as readonly string[]).includes(lower)) return spec.name;
  }
  return undefined;
}

/** Flag specs a given command accepts: the catalog's global ones plus its own. */
export function catalogFlagsForCommand<TCommand extends string, TField extends string>(
  catalog: Pick<CliCatalog<TCommand, TField, unknown>, 'commands' | 'globalFlags'>,
  command: TCommand,
): readonly CommandFlagSpec<TField>[] {
  return [...catalog.globalFlags, ...catalogCommandSpec(catalog, command).flags];
}

/**
 * The catalog's own consistency, checked rather than assumed.
 *
 * The engine's pre-scan for the command word runs before the command is
 * known and therefore reads a token's arity from the catalog-wide table
 * above — honest only while no token means one kind under one command and a
 * different kind under another. A violation is returned as a list of
 * problems, never thrown, so a catalog's own test can name them.
 */
export function findCatalogFlagArityConflicts<TCommand extends string, TField extends string>(
  catalog: Pick<CliCatalog<TCommand, TField, unknown>, 'commands' | 'globalFlags'>,
): readonly string[] {
  const seen = new Map<string, { readonly kind: CliFlagKind; readonly where: string }>();
  const problems: string[] = [];
  const check = (spec: CommandFlagSpec<TField>, where: string): void => {
    for (const token of spec.tokens) {
      const previous = seen.get(token);
      if (previous && previous.kind !== spec.kind) {
        problems.push(`${token} is ${previous.kind} in ${previous.where} but ${spec.kind} in ${where}`);
        continue;
      }
      if (!previous) seen.set(token, { kind: spec.kind, where });
    }
  };
  for (const spec of catalog.globalFlags) check(spec, 'globalFlags');
  for (const command of catalog.commands) {
    for (const spec of command.flags) check(spec, command.name);
  }
  return problems;
}
