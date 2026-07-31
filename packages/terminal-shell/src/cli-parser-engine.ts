/**
 * cli-parser-engine.ts — the argument engine.
 *
 * It knows about tokens, values, arity, `--`, and refusals. It knows nothing
 * about any one product's commands or flags: every command name, alias, flag
 * and kind it works with arrives from a `CliCatalog` (./cli-catalog-types.ts).
 * A daemon-shaped front-end and a terminal-shaped front-end drive the SAME
 * engine over two different catalogs — see cli-command-catalog.ts for this
 * package's own instance and cli-parser.ts for the thin wrapper built on it.
 *
 * THE TWO RULES A STRICT CATALOG ASKS THIS FILE TO ENFORCE
 *
 * 1. An unmatched first token can be made to refuse rather than quietly
 *    become the default command's positional argument — a bare invocation
 *    (or a fully passthrough one) is one thing; a plain typo that silently
 *    started the default behavior anyway is the defect class this exists to
 *    end. `CliCatalog.unmatchedFirstToken` decides which a given catalog
 *    wants; a catalog earns the strict behavior by declaring `'reject'`.
 * 2. Every refusal is a refusal. A flag that belongs to another surface, a
 *    flag this command does not take (unless the command opts into lenient
 *    unknown-flag passthrough), a missing value — each produces an error
 *    line, never an accept-and-ignore.
 */
import {
  catalogCommandSpec,
  catalogFlagArity,
  catalogFlagsForCommand,
  resolveCatalogCommand,
  type CliCatalog,
  type CliFlagKind,
  type CliFlagValue,
  type CommandFlagSpec,
  type CommandSpec,
  type EngineParseResult,
} from './cli-catalog-types.js';

function isOptionToken(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

/**
 * Whether a token may stand as an OPTIONAL flag's value.
 *
 * Stricter than `isOptionToken` by exactly one token: a bare `-` is the stdin
 * convention, a positional in its own right, and swallowing it as `--fork`'s or
 * `--resume`'s value would turn "resume the latest session, reading stdin" into
 * "resume the session named `-`". A REQUIRED value is a different question — a
 * flag that must have one and is handed `-` gets `-`, because refusing it would
 * only produce a "requires a value" error over a token the user did supply.
 */
function canBeOptionalValue(token: string | undefined): token is string {
  return token !== undefined && !token.startsWith('-');
}

/** `--name=value` split into its two halves; a bare `--name` yields no value. */
function splitOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return { name: token.slice(0, index), value: token.slice(index + 1) };
}

/**
 * Whether a token of this kind consumes the FOLLOWING token as its value, used
 * both by the command-word scan (before any command is known) and by the main
 * pass when a flag turns out to be unaccepted here.
 *
 * It has to answer exactly what the main pass will actually do, or the two
 * disagree about which tokens are values and the scan reports a flag's
 * neighbour as the command word. `boolean` and `const` never consume;
 * `string-optional` consumes only what {@link canBeOptionalValue} allows; every
 * other kind consumes only a token that is really there and is not itself
 * option-shaped — a flag whose value is missing is refused, and refusing it does
 * not eat the next token.
 */
function kindConsumesNextValue(kind: CliFlagKind, argv: readonly string[], index: number): boolean {
  if (kind === 'boolean' || kind === 'const') return false;
  const next = argv[index + 1];
  if (kind === 'string-optional') return canBeOptionalValue(next);
  return next !== undefined && !isOptionToken(next);
}

/**
 * The command-word candidate: a non-flag token, and where it sits.
 *
 * This runs before the command is known, so it cannot use that command's own
 * flag list to decide which tokens are option VALUES rather than the
 * candidate word. It uses the catalog-wide arity table instead: every token
 * that appears in more than one command's flags has the same kind in all of
 * them, which `findCatalogFlagArityConflicts` holds a catalog to.
 *
 * `keepLooking` is what separates the two catalog postures. A catalog that
 * REJECTS an unmatched word is answered by the first non-flag token and nothing
 * after it — that token is either the command or the refusal. A catalog that
 * lets an unmatched word pass through as an ordinary positional has to keep
 * looking, because in `run a-file.txt` the word that names the command may not
 * be the first one: stopping at the first token would silently start the
 * default command instead.
 */
function findCommandWordToken(
  argv: readonly string[],
  arity: ReadonlyMap<string, CliFlagKind>,
  rejectedFlags: Readonly<Record<string, { readonly takesValue: boolean }>> | undefined,
  keepLooking: (token: string) => boolean,
): { readonly token: string; readonly index: number } | null {
  let first: { readonly token: string; readonly index: number } | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') break;
    if (!isOptionToken(token)) {
      if (first === null) first = { token, index };
      if (!keepLooking(token)) return { token, index };
      continue;
    }
    const { name, value } = splitOption(token);
    if (value !== undefined) continue;
    const kind = arity.get(name);
    if (kind !== undefined) {
      if (kindConsumesNextValue(kind, argv, index)) index += 1;
      continue;
    }
    // A flag this catalog refuses still has to have its VALUE skipped, or the
    // first token after it reports as "the command" instead of the refusal
    // naming the flag that is actually the problem.
    if (rejectedFlags?.[name]?.takesValue === true) index += 1;
  }
  return first;
}

function parsePort(value: string, optionName: string, errors: string[]): number | undefined {
  if (!/^\d+$/.test(value)) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  return port;
}

/** Which flag spec (if any) a token selects, among the ones a command accepts. */
function findFlagSpec<TField extends string>(
  accepted: readonly CommandFlagSpec<TField>[],
  name: string,
): CommandFlagSpec<TField> | undefined {
  return accepted.find((spec) => spec.tokens.includes(name));
}

type FieldRecord<TField extends string> = Record<TField, CliFlagValue>;

/**
 * Assigns one field on a product's flags record.
 *
 * Cast, not `any`: the engine is generic over TFlags (a product's own
 * interface, e.g. `GoodVibesCliFlags`), so it cannot know that interface's
 * exact shape — only that a catalog's flag specs name fields that exist on
 * it, which is the whole contract a catalog makes. `TField` is the type-safe
 * half of that contract; this cast is what lets one engine assign to any
 * product's differently-shaped record without a hardcoded switch over field
 * names (the daemon's own first cut of this engine had exactly that switch,
 * which is the thing a shared package needs not to repeat per product).
 */
function setField<TFlags, TField extends string>(flags: TFlags, field: TField, value: CliFlagValue): void {
  (flags as unknown as FieldRecord<TField>)[field] = value;
}

function getField<TFlags, TField extends string>(flags: TFlags, field: TField): CliFlagValue {
  return (flags as unknown as FieldRecord<TField>)[field];
}

/**
 * The refusal for a flag this catalog understands but this command does not,
 * or one it does not understand at all. Both name what to do next.
 */
function unacceptedOptionError<TCommand extends string, TField extends string>(
  catalog: Pick<CliCatalog<TCommand, TField, unknown>, 'commands' | 'globalFlags'>,
  spec: CommandSpec<TCommand, TField>,
  arity: ReadonlyMap<string, CliFlagKind>,
  name: string,
): string {
  const accepted = catalogFlagsForCommand(catalog, spec.name)
    .flatMap((flagSpec) => flagSpec.tokens)
    .filter((token) => token.startsWith('--'))
    .join(', ');
  return arity.has(name)
    ? `${name} is not a flag \`${spec.name}\` takes. It accepts: ${accepted}`
    : `Unknown option: ${name}. \`${spec.name}\` accepts: ${accepted}`;
}

/**
 * Consume one flag's value: an inline `=value` if present, else the next
 * token unless it is missing or itself option-shaped. Returns undefined (and
 * advances nothing) when no value was available; the caller reports the
 * "requires a value" refusal.
 */
function consumeValue(argv: readonly string[], index: number, inlineValue: string | undefined): { readonly value: string | undefined; readonly nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || isOptionToken(next)) return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

/**
 * Parse a command line against a catalog.
 *
 * Never throws: every problem comes back as a line in `errors`, so the
 * caller decides how to report it.
 */
export function parseWithCatalog<TCommand extends string, TField extends string, TFlags>(
  argv: readonly string[],
  catalog: CliCatalog<TCommand, TField, TFlags>,
  binary: string,
): EngineParseResult<TCommand, TFlags> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const commandArgs: string[] = [];
  const positionals: string[] = [];
  const flags = catalog.createDefaultFlags();

  const arity = catalogFlagArity(catalog);
  const rejects = catalog.unmatchedFirstToken === 'reject';
  const found = findCommandWordToken(
    argv,
    arity,
    catalog.rejectedFlags,
    (token) => !rejects && resolveCatalogCommand(catalog, token) === undefined,
  );

  let command: TCommand = catalog.defaultCommand;
  let rawCommand: string | undefined;
  let sawCommand = false;

  if (found) {
    const resolved = resolveCatalogCommand(catalog, found.token);
    if (resolved === undefined) {
      if (catalog.unmatchedFirstToken === 'reject') {
        errors.push(`Unknown command: ${found.token}`);
        return {
          binary,
          command: catalog.unresolvedCommandSentinel ?? catalog.defaultCommand,
          rawCommand: found.token,
          commandArgs: [],
          positionals: [],
          flags: catalog.createDefaultFlags(),
          errors,
          warnings,
        };
      }
      // 'passthrough': the token stands as an ordinary positional below; the
      // command stays the catalog default and sawCommand stays false, so the
      // REST of argv is also parsed in the pre-command (strict) posture —
      // matching a single unmatched word never partially unlocking anything.
    } else {
      command = resolved;
      rawCommand = found.token;
      sawCommand = true;
    }
  }

  const spec = catalogCommandSpec(catalog, command);
  const accepted = catalogFlagsForCommand(catalog, command);
  const lenient = spec.lenientUnknownFlags === true;
  const rawPassthrough = spec.passthrough === true;
  const stopAt = sawCommand && rawPassthrough ? found!.index : argv.length;

  let ddashSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (sawCommand && index === found!.index) continue; // the command word itself

    if (sawCommand && rawPassthrough && index > stopAt) {
      commandArgs.push(token);
      positionals.push(token);
      continue;
    }

    // A token belongs to the COMMAND only if it was typed after the command
    // word. Anything before it was typed before the line said which command was
    // being run, so it is a bare positional of the invocation, not an argument
    // handed on to that command.
    const afterCommandWord = sawCommand && index > found!.index;

    if (ddashSeen) {
      if (afterCommandWord) commandArgs.push(token); else positionals.push(token);
      continue;
    }
    if (token === '--') {
      ddashSeen = true;
      continue;
    }

    if (!isOptionToken(token)) {
      positionals.push(token);
      if (afterCommandWord) commandArgs.push(token);
      continue;
    }

    const { name, value: inlineValue } = splitOption(token);
    const flagSpec = findFlagSpec(accepted, name);

    if (!flagSpec) {
      const rejected = catalog.rejectedFlags?.[name];
      if (rejected) {
        errors.push(`${name} is not a ${binary} flag — ${rejected.reason} belongs to another surface.`);
        if (inlineValue === undefined && rejected.takesValue) index += 1;
        continue;
      }
      // Lenient passthrough is a property of the position, not of the whole
      // line: a flag typed BEFORE the command word was typed before anything
      // said which command would tolerate it, so it is still a refusal. Only
      // what follows the command word rides on that command's leniency.
      if (afterCommandWord && lenient) {
        commandArgs.push(token);
        continue;
      }
      errors.push(unacceptedOptionError(catalog, spec, arity, name));
      const kind = arity.get(name);
      if (inlineValue === undefined && kind !== undefined && kindConsumesNextValue(kind, argv, index)) index += 1;
      continue;
    }

    switch (flagSpec.kind) {
      case 'boolean': {
        if (inlineValue !== undefined) { errors.push(`${name} takes no value.`); break; }
        setField(flags, flagSpec.field, true);
        break;
      }
      case 'const': {
        if (inlineValue !== undefined) { errors.push(`${name} takes no value.`); break; }
        setField(flags, flagSpec.field, flagSpec.constValue);
        break;
      }
      case 'string-optional': {
        let raw: string | undefined = inlineValue;
        if (raw === undefined) {
          const next = argv[index + 1];
          if (canBeOptionalValue(next)) { raw = next; index += 1; }
        }
        setField(flags, flagSpec.field, raw ?? flagSpec.bareValue);
        break;
      }
      case 'port': {
        const consumed = consumeValue(argv, index, inlineValue);
        index = consumed.nextIndex;
        if (consumed.value === undefined) { errors.push(`${name} requires a value.`); break; }
        const port = parsePort(consumed.value, name, errors);
        if (port !== undefined) setField(flags, flagSpec.field, port);
        break;
      }
      case 'string-list': {
        const consumed = consumeValue(argv, index, inlineValue);
        index = consumed.nextIndex;
        if (consumed.value === undefined) { errors.push(`${name} requires a value.`); break; }
        const current = getField(flags, flagSpec.field);
        const list = Array.isArray(current) ? (current as readonly string[]) : [];
        setField(flags, flagSpec.field, [...list, consumed.value]);
        break;
      }
      case 'string': {
        const consumed = consumeValue(argv, index, inlineValue);
        index = consumed.nextIndex;
        if (consumed.value === undefined) { errors.push(`${name} requires a value.`); break; }
        setField(flags, flagSpec.field, consumed.value);
        break;
      }
      case 'enum': {
        const consumed = consumeValue(argv, index, inlineValue);
        index = consumed.nextIndex;
        if (consumed.value === undefined) {
          errors.push(`${name} requires a value.`);
          // A defaulted enum states its allowed values on a missing value too,
          // and falls back to that default: the flag was written, so leaving
          // whatever an earlier flag happened to set would report a choice the
          // line did not make.
          if (flagSpec.enumDefault !== undefined) {
            if (flagSpec.enumValues) errors.push(`${name} must be one of: ${flagSpec.enumValues.join(', ')}.`);
            setField(flags, flagSpec.field, flagSpec.enumDefault);
          }
          break;
        }
        if (flagSpec.enumValues && !flagSpec.enumValues.includes(consumed.value)) {
          errors.push(`${name} must be one of: ${flagSpec.enumValues.join(', ')}.`);
          if (flagSpec.enumDefault !== undefined) setField(flags, flagSpec.field, flagSpec.enumDefault);
        } else {
          setField(flags, flagSpec.field, consumed.value);
        }
        break;
      }
    }
    if (flagSpec.warning) warnings.push(flagSpec.warning);
  }

  const result: EngineParseResult<TCommand, TFlags> = {
    binary, command, rawCommand, commandArgs, positionals, flags, errors, warnings,
  };
  return catalog.postProcess ? catalog.postProcess(result) : result;
}

export {
  catalogCommandSpec,
  catalogFlagArity,
  catalogFlagsForCommand,
  resolveCatalogCommand,
  findCatalogFlagArityConflicts,
} from './cli-catalog-types.js';
