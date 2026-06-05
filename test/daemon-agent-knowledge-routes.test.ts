import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { DaemonServer } from '../packages/sdk/src/platform/daemon/facade.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createRuntimeServices } from '../packages/sdk/src/platform/runtime/services.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import { GOODVIBES_AGENT_KNOWLEDGE_DB_FILE } from '../packages/sdk/src/platform/knowledge/index.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function dispatch(
  daemon: DaemonServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const handleRequest = (daemon as unknown as {
    handleRequest(req: Request): Promise<Response>;
  }).handleRequest.bind(daemon);
  return await handleRequest(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-token',
      ...(init.headers ?? {}),
    },
  }));
}

describe('daemon Agent knowledge route wiring', () => {
  test('normalizes injected runtime services that predate agentKnowledgeService', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-agent-knowledge-routes-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const runtimeBus = new RuntimeEventBus();
    const configManager = new ConfigManager({
      homeDir: homeDirectory,
      workingDir,
      surfaceRoot: 'goodvibes-test',
    });
    const runtimeServices = createRuntimeServices({
      configManager,
      runtimeBus,
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'goodvibes',
      getConversationTitle: () => 'goodvibes test daemon',
      workingDir,
      homeDirectory,
    });

    // Simulate an embedding host that updated DaemonServer before refreshing
    // its injected runtime-services object. The daemon must still create an
    // isolated Agent knowledge service instead of wiring undefined handlers or
    // falling back to regular Knowledge/Wiki.
    delete (runtimeServices as Partial<typeof runtimeServices>).agentKnowledgeService;

    const daemon = new DaemonServer({ runtimeServices });
    daemon.enable({ daemon: true }, 'test-token');

    const status = await dispatch(daemon, '/api/goodvibes-agent/knowledge/status');
    expect(status.status).toBe(200);
    const statusBody = await status.json() as Record<string, unknown>;
    expect(statusBody).toMatchObject({ sourceCount: 0, nodeCount: 0, issueCount: 0 });

    const ask = await dispatch(daemon, '/api/goodvibes-agent/knowledge/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is GoodVibes Agent?' }),
    });
    expect(ask.status).toBe(200);

    const search = await dispatch(daemon, '/api/goodvibes-agent/knowledge/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'GoodVibes Agent', limit: 5 }),
    });
    expect(search.status).toBe(200);
    const searchBody = await search.json() as { results?: unknown[] };
    expect(searchBody.results).toEqual([]);

    expect(
      (runtimeServices as unknown as {
        agentKnowledgeService?: { readonly store?: { readonly storagePath?: string } };
      }).agentKnowledgeService?.store?.storagePath,
    ).toEndWith(GOODVIBES_AGENT_KNOWLEDGE_DB_FILE);
  });
});
