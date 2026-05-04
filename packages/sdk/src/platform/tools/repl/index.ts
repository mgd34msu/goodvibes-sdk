import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { executeSandboxCommand } from '../../runtime/sandbox/backend.js';
import { type ConfigManagerLike } from '../../runtime/sandbox/manager.js';
import { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.js';
import { requireSurfaceRoot } from '../../runtime/surface-root.js';
import type { SandboxLaunchPlan } from '../../runtime/sandbox/types.js';
import type { Tool } from '../../types/tools.js';
import { summarizeError } from '../../utils/error-display.js';
import { REPL_TOOL_SCHEMA, type ReplToolInput } from './schema.js';

const REPL_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG'] as const;

interface ReplHistoryEntry {
  readonly ts: number;
  readonly runtime: 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql';
  readonly expression: string;
  readonly sessionId?: string | undefined;
  readonly backend?: string | undefined;
  readonly launchSummary?: string | undefined;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}

type ReplExecutionInput = ReplToolInput & {
  readonly workspaceRoot?: string | undefined;
};

export interface ReplToolOptions {
  readonly surfaceRoot: string;
}

function resolveHistoryPath(workspaceRoot: string, surfaceRoot: string): string {
  return join(workspaceRoot, '.goodvibes', surfaceRoot, 'repl-history.json');
}

function createReplEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of REPL_ENV_ALLOWLIST) {
    const value = process.env[key]!;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function requireReplSandbox(launchPlan: SandboxLaunchPlan | undefined): SandboxLaunchPlan {
  if (!launchPlan || launchPlan.backend !== 'qemu') {
    throw new Error('REPL eval requires an explicit QEMU sandbox backend; configure sandbox.vmBackend, sandbox.qemuImagePath, and sandbox.qemuExecWrapper before evaluating code.');
  }
  return launchPlan;
}

async function loadHistory(historyPath: string): Promise<ReplHistoryEntry[]> {
  try {
    return JSON.parse(await readFile(historyPath, 'utf-8')) as ReplHistoryEntry[];
  } catch {
    return [];
  }
}

async function saveHistory(historyPath: string, entries: readonly ReplHistoryEntry[]): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
}

function mapRuntimeToSandboxProfile(runtime: NonNullable<ReplToolInput['runtime']>) {
  switch (runtime) {
    case 'javascript': return 'eval-js' as const;
    case 'typescript': return 'eval-ts' as const;
    case 'python': return 'eval-py' as const;
    case 'sql': return 'eval-sql' as const;
    case 'graphql': return 'eval-graphql' as const;
  }
}

async function evalJavaScriptInSandbox(
  expression: string,
  bindings: Record<string, unknown>,
  launchPlan: SandboxLaunchPlan,
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  sessionId?: string,
): Promise<string> {
  if (launchPlan.backend !== 'qemu') {
    throw new Error('evalJavaScriptInSandbox: refusing to run outside QEMU sandbox');
  }
  const payload = JSON.stringify({ expression, bindings });
  const runner = `
const payload = JSON.parse(process.env.GV_REPL_PAYLOAD ?? '{}');
const bindings = payload.bindings ?? {};
for (const [key, value] of Object.entries(bindings)) {
  globalThis[key] = value;
}
const value = eval(payload.expression);
process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
`;
  const result = sessionId
    ? sandboxSessionRegistry.execute(sessionId, process.execPath, ['-e', runner], configManager, {
        timeoutMs: 1000,
        inheritHostEnv: false,
        env: createReplEnv({ GV_REPL_PAYLOAD: payload }),
      })
    : executeSandboxCommand(launchPlan, process.execPath, ['-e', runner], {
        timeoutMs: 1000,
        inheritHostEnv: false,
        env: createReplEnv({ GV_REPL_PAYLOAD: payload }),
      });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'JavaScript eval failed.').trim());
  }
  return result.stdout.trim();
}

async function evalTypeScript(
  expression: string,
  bindings: Record<string, unknown>,
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  launchPlan: SandboxLaunchPlan,
  sessionId?: string,
): Promise<string> {
  const transpiled = ts.transpileModule(expression, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
  return evalJavaScriptInSandbox(transpiled, bindings, launchPlan, configManager, sandboxSessionRegistry, sessionId);
}

function evalPython(
  expression: string,
  workspaceRoot: string,
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  launchPlan: SandboxLaunchPlan,
  sessionId?: string,
): string {
  const run = sessionId
    ? sandboxSessionRegistry.execute(sessionId, 'python3', ['-I', '-S', '-c', `import json\nresult = (${expression})\nprint(json.dumps(result))`], configManager, {
        cwd: workspaceRoot,
        timeoutMs: 5000,
        inheritHostEnv: false,
        env: createReplEnv(),
      })
    : executeSandboxCommand(launchPlan, 'python3', ['-I', '-S', '-c', `import json\nresult = (${expression})\nprint(json.dumps(result))`], {
        cwd: workspaceRoot,
        timeoutMs: 5000,
        inheritHostEnv: false,
        env: createReplEnv(),
      });
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || 'Python eval failed.').trim());
  }
  return run.stdout.trim();
}

async function evalSql(
  expression: string,
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  launchPlan: SandboxLaunchPlan,
  sessionId?: string,
): Promise<string> {
  const payload = JSON.stringify({ expression });
  const script = `
import { Database } from 'bun:sqlite';
import { summarizeError } from '../../utils/error-display.js';
const payload = JSON.parse(process.env.GV_REPL_PAYLOAD ?? '{}');
const db = new Database(':memory:');
db.exec("CREATE TABLE sandbox_eval (id INTEGER PRIMARY KEY, value TEXT);");
db.exec("INSERT INTO sandbox_eval (value) VALUES ('alpha'), ('beta');");
const rows = db.query(payload.expression).all();
process.stdout.write(JSON.stringify(rows));
`;
  const result = sessionId
    ? sandboxSessionRegistry.execute(sessionId, process.execPath, ['-e', script], configManager, {
        timeoutMs: 5000,
        inheritHostEnv: false,
        env: createReplEnv({ GV_REPL_PAYLOAD: payload }),
      })
    : executeSandboxCommand(launchPlan, process.execPath, ['-e', script], {
        timeoutMs: 5000,
        inheritHostEnv: false,
        env: createReplEnv({ GV_REPL_PAYLOAD: payload }),
      });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'SQL eval failed.').trim());
  }
  return result.stdout.trim();
}

function evalGraphql(
  expression: string,
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  launchPlan: SandboxLaunchPlan,
  sessionId?: string,
): string {
  const payload = JSON.stringify({ expression });
  const script = `
const payload = JSON.parse(process.env.GV_REPL_PAYLOAD ?? '{}');
const normalized = String(payload.expression ?? '').replace(/\\s+/g, ' ').trim();
const opMatch = normalized.match(/^(query|mutation|subscription)\\s+([A-Za-z0-9_]+)?/i);
const fields = [...normalized.matchAll(/\\b([A-Za-z_][A-Za-z0-9_]*)\\b/g)].map((match) => match[1]).slice(0, 12);
process.stdout.write(JSON.stringify({
  operation: opMatch?.[1]?.toLowerCase() ?? 'query',
  name: opMatch?.[2] ?? null,
  fields,
  normalized,
}));
`;
  const result = sessionId
    ? sandboxSessionRegistry.execute(sessionId, process.execPath, ['-e', script], configManager, {
        timeoutMs: 2000,
        inheritHostEnv: false,
        env: createReplEnv({ GV_REPL_PAYLOAD: payload }),
      })
    : executeSandboxCommand(launchPlan, process.execPath, ['-e', script], {
        timeoutMs: 2000,
        inheritHostEnv: false,
        env: createReplEnv({ GV_REPL_PAYLOAD: payload }),
      });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'GraphQL eval failed.').trim());
  }
  return result.stdout.trim();
}

export function createReplTool(
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  options: ReplToolOptions,
): Tool {
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'ReplTool surfaceRoot');
  return {
    definition: {
      name: 'repl',
      description: 'Evaluate bounded JavaScript, TypeScript, Python, SQL, and GraphQL snippets through controlled sandbox profiles.',
      parameters: REPL_TOOL_SCHEMA.parameters,
      sideEffects: ['exec', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as ReplExecutionInput;
      if (!input.workspaceRoot || input.workspaceRoot.trim().length === 0) {
        return { success: false, error: 'repl requires workspaceRoot.' };
      }
      const historyPath = resolveHistoryPath(input.workspaceRoot, surfaceRoot);
      const history = await loadHistory(historyPath);

      if (input.mode === 'history') {
        return { success: true, output: JSON.stringify({ count: history.length, history }) };
      }

      if (!input.expression) return { success: false, error: 'eval requires expression.' };
      const runtime = input.runtime ?? 'javascript';
      const sandboxSession = await sandboxSessionRegistry.start(
        mapRuntimeToSandboxProfile(runtime),
        `repl:${runtime}`,
        configManager,
      );
      try {
        const launchPlan = requireReplSandbox(sandboxSession.launchPlan);
        let rendered = '';
        switch (runtime) {
          case 'javascript':
            rendered = await evalJavaScriptInSandbox(input.expression, input.bindings ?? {}, launchPlan, configManager, sandboxSessionRegistry, sandboxSession.id);
            break;
          case 'typescript':
            rendered = await evalTypeScript(input.expression, input.bindings ?? {}, configManager, sandboxSessionRegistry, launchPlan, sandboxSession.id);
            break;
          case 'python':
            rendered = evalPython(input.expression, input.workspaceRoot, configManager, sandboxSessionRegistry, launchPlan, sandboxSession.id);
            break;
          case 'sql':
            rendered = await evalSql(input.expression, configManager, sandboxSessionRegistry, launchPlan, sandboxSession.id);
            break;
          case 'graphql':
            rendered = evalGraphql(input.expression, configManager, sandboxSessionRegistry, launchPlan, sandboxSession.id);
            break;
        }
        await saveHistory(historyPath, [...history, {
          ts: Date.now(),
          runtime,
          expression: input.expression,
          sessionId: sandboxSession.id,
          backend: sandboxSession.resolvedBackend ?? sandboxSession.backend,
          launchSummary: sandboxSession.launchPlan?.summary,
          result: rendered,
        }]);
        return { success: true, output: rendered };
      } catch (error) {
        await saveHistory(historyPath, [...history, {
          ts: Date.now(),
          runtime,
          expression: input.expression,
          sessionId: sandboxSession.id,
          backend: sandboxSession.resolvedBackend ?? sandboxSession.backend,
          launchSummary: sandboxSession.launchPlan?.summary,
          error: summarizeError(error),
        }]);
        return { success: false, error: summarizeError(error) };
      }
    },
  };
}
