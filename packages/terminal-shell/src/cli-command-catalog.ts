/**
 * cli-command-catalog.ts — WHAT a terminal-shaped front-end's command line
 * understands.
 *
 * This file is data (plus the handful of pure functions its own field
 * semantics need — inferring a provider from a `provider:model` key, folding
 * leftover positionals into a prompt). It holds no argv-walking logic of its
 * own: cli-parser-engine.ts is the engine, handed this catalog and an
 * argument list, and it knows nothing about any specific command. `--print`
 * and `--prompt` implying the `run` command, `--non-interactive` also
 * implying `--yes`, and the session-lifecycle-flag conflict check are this
 * catalog's own domain rules, wired through its `postProcess` hook — the one
 * seam the engine leaves for a product to have opinions the engine itself
 * must not.
 *
 * GLOBAL_FLAGS is every flag this vocabulary recognizes; no command declares
 * flags of its own beyond them, which is this vocabulary's actual current
 * shape: an operator-facing subcommand's own arguments (`auth add-user
 * --role admin`, `secrets delete KEY`) are this catalog's `commandArgs`
 * output, interpreted by that subcommand's own handler, not by anything
 * declared here.
 */
import type { CliCatalog, CommandFlagSpec, CommandSpec, EngineParseResult } from './cli-catalog-types.js';
import type { GoodVibesCliCommand, GoodVibesCliFlags, GoodVibesCliOutputFormat } from './cli-types.js';

/** Every field a flag in this vocabulary can land on. */
export type GoodVibesCliFlagField = keyof GoodVibesCliFlags;

function createDefaultFlags(): GoodVibesCliFlags {
  return {
    provider: undefined,
    model: undefined,
    daemonHome: undefined,
    workingDir: undefined,
    help: false,
    version: false,
    prompt: undefined,
    print: false,
    outputFormat: 'text',
    configOverrides: [],
    enableFeatures: [],
    disableFeatures: [],
    noAltScreen: false,
    port: undefined,
    hostname: undefined,
    open: false,
    continueLast: false,
    resume: undefined,
    session: undefined,
    fork: undefined,
    yes: false,
    nonInteractive: false,
    strict: false,
  };
}

/**
 * `provider:model` and `provider/model` name the provider inside the model
 * id. An explicit `--provider` always wins — the engine only calls this when
 * none was given.
 */
function inferProviderFromModel(model: string): string | undefined {
  if (model.includes(':')) return model.split(':')[0];
  if (model.includes('/')) return model.split('/')[0];
  return undefined;
}

const OUTPUT_FORMAT_VALUES: readonly GoodVibesCliOutputFormat[] = ['text', 'json', 'stream-json'];

const GLOBAL_FLAGS: readonly CommandFlagSpec<GoodVibesCliFlagField>[] = [
  { tokens: ['--help', '-h'], field: 'help', kind: 'boolean', summary: 'Print help and exit 0.' },
  { tokens: ['--version', '-v'], field: 'version', kind: 'boolean', summary: 'Print the version and exit 0.' },
  {
    tokens: ['--print'],
    field: 'print',
    kind: 'boolean',
    summary: 'Print one conversation turn instead of opening the terminal UI. Implies `run` with no command word.',
  },
  {
    tokens: ['--json'],
    field: 'outputFormat',
    kind: 'const',
    constValue: 'json',
    summary: 'Shorthand for --output json.',
  },
  { tokens: ['--no-alt-screen'], field: 'noAltScreen', kind: 'boolean', summary: 'Do not use the terminal alt screen.' },
  { tokens: ['--open'], field: 'open', kind: 'boolean', summary: 'Open a browser window for the web surface.' },
  { tokens: ['--continue'], field: 'continueLast', kind: 'boolean', summary: 'Resume the last conversation.' },
  {
    tokens: ['--fork'],
    field: 'fork',
    kind: 'string-optional',
    bareValue: true,
    valueName: 'id',
    summary: 'Fork a conversation. With no id, forks the current one.',
  },
  { tokens: ['--yes', '-y'], field: 'yes', kind: 'boolean', summary: 'Answer confirmation prompts with yes.' },
  {
    tokens: ['--non-interactive'],
    field: 'nonInteractive',
    kind: 'boolean',
    summary: 'Never prompt. Implies --yes.',
  },
  {
    tokens: ['--strict'],
    field: 'strict',
    kind: 'boolean',
    summary: "doctor: advisory findings also fail (exit 1), for CI. Ignored by every other command.",
  },
  { tokens: ['--provider'], field: 'provider', kind: 'string', valueName: 'id', summary: 'Run with this provider.' },
  {
    tokens: ['--model', '-m'],
    field: 'model',
    kind: 'string',
    valueName: 'registryKey',
    summary: 'Run with this model. A provider:model key also sets the provider, unless --provider was given too.',
  },
  {
    tokens: ['--daemon-home'],
    field: 'daemonHome',
    kind: 'string',
    valueName: 'dir',
    summary: "The daemon's own identity directory.",
  },
  {
    tokens: ['--working-dir', '--cd', '-C'],
    field: 'workingDir',
    kind: 'string',
    valueName: 'dir',
    summary: 'The directory this front-end treats as its workspace.',
  },
  {
    tokens: ['--prompt', '-p'],
    field: 'prompt',
    kind: 'string',
    valueName: 'text',
    summary: 'Send this prompt. Implies `run` with no command word.',
  },
  {
    tokens: ['--output-format'],
    field: 'outputFormat',
    kind: 'enum',
    enumValues: OUTPUT_FORMAT_VALUES,
    enumDefault: 'text',
    valueName: 'format',
    summary: 'Deprecated alias for --output.',
    warning: '--output-format is deprecated; use --output (or -o) instead.',
  },
  {
    tokens: ['--output', '-o'],
    field: 'outputFormat',
    kind: 'enum',
    enumValues: OUTPUT_FORMAT_VALUES,
    enumDefault: 'text',
    valueName: 'format',
    summary: 'Output format: text, json, or stream-json.',
  },
  {
    tokens: ['--config', '-c'],
    field: 'configOverrides',
    kind: 'string-list',
    valueName: 'key=value',
    summary: 'Override one settings key for this run only. Repeatable.',
  },
  {
    tokens: ['--enable'],
    field: 'enableFeatures',
    kind: 'string-list',
    valueName: 'feature',
    summary: 'Switch a capability on for this run. Repeatable.',
  },
  {
    tokens: ['--disable'],
    field: 'disableFeatures',
    kind: 'string-list',
    valueName: 'feature',
    summary: 'Switch a capability off for this run. Repeatable.',
  },
  { tokens: ['--port'], field: 'port', kind: 'port', valueName: 'n', summary: 'Port to bind or call.' },
  {
    tokens: ['--hostname', '--host'],
    field: 'hostname',
    kind: 'string',
    valueName: 'host',
    summary: 'Bind address for the endpoint the selected command owns.',
  },
  {
    tokens: ['--resume', '-r'],
    field: 'resume',
    kind: 'string-optional',
    bareValue: 'latest',
    valueName: 'id',
    summary: 'Resume a conversation. With no id, resumes the most recent.',
  },
  {
    tokens: ['--session', '-s'],
    field: 'session',
    kind: 'string',
    valueName: 'id',
    summary: 'Select a conversation by id.',
  },
];

/**
 * Every command word this vocabulary accepts. Every entry declares no flags
 * of its own (see the file header) and is lenient toward an unmatched option
 * token once its own word has been consumed — this vocabulary's real current
 * shape is one flat set of global flags, with a subcommand's further
 * arguments left for its own handler downstream.
 */
const COMMANDS: readonly CommandSpec<GoodVibesCliCommand, GoodVibesCliFlagField>[] = ([
  ['tui', ['app']],
  ['run', ['exec', 'e']],
  ['serve', ['daemon', 'server']],
  ['web', []],
  ['service', ['services']],
  ['status', []],
  ['doctor', []],
  ['onboarding', ['setup']],
  ['models', ['model']],
  ['providers', ['provider']],
  ['auth', []],
  ['subscription', ['subscriptions']],
  ['secrets', ['secret']],
  ['sessions', ['session']],
  ['tasks', ['task']],
  ['pair', ['qrcode', 'qr']],
  ['surfaces', ['surface']],
  ['listener', ['http-listener', 'webhook']],
  ['control-plane', ['controlplane', 'cp']],
  // `bundle`/`bundles` are retained as backward-compat aliases for the shipped
  // command word; the primary, unambiguous name is `support-bundle` (distinct
  // from the `plugin bundles` capability-bundle surface).
  ['support-bundle', ['bundle', 'bundles']],
  ['remote', []],
  ['bridge', []],
  ['hooks', ['hook']],
  ['plugin', ['plugins']],
  ['completion', ['completions']],
  ['help', []],
  ['version', []],
] as const).map(([name, aliases]) => ({
  name,
  aliases,
  flags: [],
  passthrough: false,
  lenientUnknownFlags: true,
  subcommands: [],
})) as readonly CommandSpec<GoodVibesCliCommand, GoodVibesCliFlagField>[];

/**
 * Non-interactive implies yes; a model key backfills an unset provider;
 * `--print`/`--prompt` with no explicit command word implies `run`; leftover
 * positionals become the prompt for a `run` (or `--print`) invocation with
 * none set otherwise; and only one of --continue/--resume/--fork may be
 * used. These are this vocabulary's own domain rules — the engine enforces
 * none of them, and a catalog with no such rules (there is nothing the
 * daemon's own vocabulary needs this hook for today) simply omits it.
 */
function postProcess(
  result: EngineParseResult<GoodVibesCliCommand, GoodVibesCliFlags>,
): EngineParseResult<GoodVibesCliCommand, GoodVibesCliFlags> {
  let flags = result.flags;
  let command = result.command;
  const errors = [...result.errors];

  if (flags.nonInteractive) flags = { ...flags, yes: true };

  if (flags.model !== undefined && flags.provider === undefined) {
    const inferred = inferProviderFromModel(flags.model);
    if (inferred !== undefined) flags = { ...flags, provider: inferred };
  }

  if (result.rawCommand === undefined && (flags.print || flags.prompt !== undefined)) {
    command = 'run';
  }

  if (flags.prompt === undefined && (command === 'run' || flags.print) && result.positionals.length > 0) {
    flags = { ...flags, prompt: result.positionals.join(' ') };
  }

  const sessionLifecycleFlags = [
    flags.continueLast ? '--continue' : undefined,
    flags.resume !== undefined ? '--resume' : undefined,
    flags.fork !== undefined ? '--fork' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (sessionLifecycleFlags.length > 1) {
    errors.push(
      `Conflicting session lifecycle flags: ${sessionLifecycleFlags.join(' and ')}. Use only one of --continue, --resume, or --fork.`,
    );
  }

  return { ...result, command, flags, errors };
}

/** The shared terminal front-end vocabulary `parseGoodVibesCli` is built from. */
export const GOODVIBES_CLI_CATALOG: CliCatalog<GoodVibesCliCommand, GoodVibesCliFlagField, GoodVibesCliFlags> = {
  commands: COMMANDS,
  globalFlags: GLOBAL_FLAGS,
  defaultCommand: 'tui',
  // Preserves this vocabulary's exact current behavior: an unrecognized first
  // word has never been refused here (unlike a daemon-shaped catalog, which
  // opts into 'reject' instead) — it silently becomes an ordinary positional
  // under the default command, e.g. feeding the prompt-from-positionals rule
  // above when combined with --print.
  unmatchedFirstToken: 'passthrough',
  createDefaultFlags,
  postProcess,
};
