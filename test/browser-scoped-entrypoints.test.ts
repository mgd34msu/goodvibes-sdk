import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { withTestTimeout } from './_helpers/test-timeout.ts';
import {
  createBrowserHomeAssistantSdk,
} from '../packages/sdk/dist/browser-homeassistant.js';
import {
  createBrowserAgentSdk,
} from '../packages/sdk/dist/browser-agent.js';
import {
  createBrowserKnowledgeSdk,
} from '../packages/sdk/dist/browser-knowledge.js';
import sdkPackage from '../packages/sdk/package.json' with { type: 'json' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createRecordingFetch(body: unknown = { ok: true }): {
  readonly calls: string[];
  readonly fetch: typeof fetch;
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(body);
    }) as typeof fetch,
  };
}

const SDK_ROOT = resolve(import.meta.dir, '..');

/**
 * How long one entrypoint bundle may take before this test stops waiting and
 * says which entrypoint it was waiting on.
 *
 * These three cases used to call `Bun.build` in-process and `await` it with no
 * ceiling at all, and that is what wedged CI: the bundler ran inside the same
 * process as the other 794 test files, and when it stopped settling there was
 * nothing to stop waiting. One run had all three cases charged the runner's
 * whole 60 000 ms per-test budget; an earlier run of the same commit produced
 * fifteen minutes of total silence and was killed by the job timeout, leaving
 * bun processes behind for the runner's orphan sweep to terminate. Fifteen
 * minutes of silence is indistinguishable from slow progress until something
 * kills it.
 *
 * So the bundle runs as a child process that this file owns: it cannot touch
 * the test runtime, it is bounded, and it is killed on every exit path
 * including the timeout and an assertion failure. The number is deliberately
 * enormous relative to the work, the same three bundles take single-digit
 * milliseconds each, because it is a ceiling, not a budget: a healthy run
 * never approaches it and never pays for it. It sits below the suite's 60 000
 * ms per-test default so that a stuck bundle is reported by the message below,
 * which names the entrypoint, rather than by the runner's generic timeout.
 */
const BUNDLE_CEILING_MS = 30_000;

async function bundleEntrypoint(entrypoint: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'gv-browser-bundle-'));
  const child = Bun.spawn(
    [
      process.execPath,
      'build',
      resolve(SDK_ROOT, entrypoint),
      '--target=browser',
      '--format=esm',
      '--packages=external',
      `--outdir=${outDir}`,
    ],
    { cwd: SDK_ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  // Drained from the start. An undrained pipe is its own way to hang: a child
  // that fills the buffer blocks on write and never reaches exit. `.catch`
  // because the kill below tears these streams down in the timeout path, and a
  // rejected read nobody is waiting on would surface as an unhandled rejection
  // attributed to whichever test happens to be running by then.
  const stdout = new Response(child.stdout).text().catch(() => '');
  const stderr = new Response(child.stderr).text().catch(() => '');
  try {
    const exitCode = await withTestTimeout(
      child.exited,
      BUNDLE_CEILING_MS,
      `bundling ${entrypoint} did not finish within ${BUNDLE_CEILING_MS}ms`,
    );
    const diagnostics = `${await stdout}\n${await stderr}`.trim();
    expect(exitCode, `bun build ${entrypoint} exited ${exitCode}:\n${diagnostics}`).toBe(0);
    const produced = readdirSync(outDir).filter((name) => name.endsWith('.js'));
    expect(produced, `bun build ${entrypoint} produced no JS output:\n${diagnostics}`).toHaveLength(1);
    const bundle = readFileSync(join(outDir, produced[0]!), 'utf-8');
    // The home assistant case below is made entirely of `not.toContain`, which
    // an empty or truncated bundle would satisfy perfectly. The subject of
    // those assertions is a real bundle of the whole entrypoint or they assert
    // nothing at all, so its size is checked once, here, rather than trusted.
    // The three real bundles are 24-31 KB.
    expect(bundle.length, `bun build ${entrypoint} produced a suspiciously small bundle`)
      .toBeGreaterThan(10_000);
    return bundle;
  } finally {
    // Every path, including the ceiling above and a failed expect: the child is
    // killed and reaped here, so nothing this file starts can outlive it into
    // the runner's post-job orphan sweep.
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    await child.exited.catch(() => undefined);
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('scoped browser SDK entrypoints', () => {
  test('package exports expose knowledge, agent, and home assistant browser seams', () => {
    expect(sdkPackage.exports['./browser/knowledge']).toEqual({
      types: './dist/browser-knowledge.d.ts',
      import: './dist/browser-knowledge.js',
    });
    expect(sdkPackage.exports['./browser/agent']).toEqual({
      types: './dist/browser-agent.d.ts',
      import: './dist/browser-agent.js',
    });
    expect(sdkPackage.exports['./browser/homeassistant']).toEqual({
      types: './dist/browser-homeassistant.d.ts',
      import: './dist/browser-homeassistant.js',
    });
  });

  test('knowledge browser sdk routes only regular knowledge methods', async () => {
    const transport = createRecordingFetch({
      ready: true,
      storagePath: '/tmp/goodvibes',
      sourceCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      issueCount: 0,
      extractionCount: 0,
      jobRunCount: 0,
      usageCount: 0,
      candidateCount: 0,
      reportCount: 0,
      scheduleCount: 0,
    });
    const sdk = createBrowserKnowledgeSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: transport.fetch,
    });

    await sdk.knowledge.status();
    expect(transport.calls).toEqual(['https://daemon.example.test/api/knowledge/status']);
    await sdk.operator.invoke('companion.chat.sessions.create', {
      title: 'WebUI chat',
      provider: 'openai',
      model: 'openai:gpt-5.5',
    });
    expect(transport.calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions');
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('homeassistant.homeGraph.status', {}),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('companion.chat.events.stream', { sessionId: 'chat-1' }),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
  });

  test('knowledge browser sdk exposes companion chat helpers and session event stream', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/events')) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: companion-chat.turn.delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"turn.delta","sessionId":"chat-1","turnId":"turn-1","delta":"Hi"}\n\n'));
            controller.close();
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/sessions')) {
        return jsonResponse({
          sessionId: 'chat-1',
          createdAt: 123,
          session: {
            id: 'chat-1',
            kind: 'companion-chat',
            title: 'WebUI chat',
            model: 'openai:gpt-5.5',
            provider: 'openai',
            systemPrompt: null,
            status: 'active',
            createdAt: 123,
            updatedAt: 123,
            closedAt: null,
            messageCount: 0,
          },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const sdk = createBrowserKnowledgeSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: fetchImpl,
    });

    await sdk.chat.sessions.create({
      title: 'WebUI chat',
      provider: 'openai',
      model: 'openai:gpt-5.5',
    });
    expect(calls[0]).toBe('https://daemon.example.test/api/companion/chat/sessions');
    await sdk.chat.sessions.list({ limit: 10 });
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions?limit=10');
    await sdk.chat.sessions.update('chat-1', {
      provider: 'openai',
      model: 'openai:gpt-5.5',
    });
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions/chat-1');
    await sdk.artifacts.create({
      filename: 'note.txt',
      mimeType: 'text/plain',
      dataBase64: 'aGVsbG8=',
    });
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/artifacts');
    await sdk.chat.messages.create('chat-1', {
      body: 'See attached',
      attachments: [{ artifactId: 'artifact-1', label: 'note.txt' }],
    });
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions/chat-1/messages');
    const events: unknown[] = [];
    const close = await sdk.chat.events.stream('chat-1', {
      onEvent: (_eventName, payload) => {
        events.push(payload);
      },
    }, { reconnect: { enabled: false } });
    await Promise.resolve();
    close();
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions/chat-1/events');
    expect(events).toEqual([{ type: 'turn.delta', sessionId: 'chat-1', turnId: 'turn-1', delta: 'Hi' }]);
  });

  test('home assistant browser sdk routes only home graph methods', async () => {
    const transport = createRecordingFetch({ ok: true });
    const sdk = createBrowserHomeAssistantSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: transport.fetch,
    });

    await sdk.homeGraph.status();
    expect(transport.calls).toEqual(['https://daemon.example.test/api/homeassistant/home-graph/status']);
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('knowledge.status', {}),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
  });

  test('agent browser sdk routes knowledge methods to the isolated agent knowledge wiki', async () => {
    const transport = createRecordingFetch({
      ready: true,
      storagePath: '/tmp/goodvibes-agent',
      sourceCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      issueCount: 0,
      extractionCount: 0,
      jobRunCount: 0,
      usageCount: 0,
      candidateCount: 0,
      reportCount: 0,
      scheduleCount: 0,
    });
    const sdk = createBrowserAgentSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: transport.fetch,
    });

    await sdk.knowledge.status();
    expect(transport.calls).toEqual(['https://daemon.example.test/api/goodvibes-agent/knowledge/status']);
    await sdk.knowledge.ask({ query: 'What is GoodVibes Agent?' });
    expect(transport.calls.at(-1)).toBe('https://daemon.example.test/api/goodvibes-agent/knowledge/ask');
    await sdk.chat.sessions.create({ title: 'Agent chat' });
    expect(transport.calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions');
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('homeassistant.homeGraph.status', {}),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
  });

  test('bundled knowledge entrypoint does not include Home Graph contract metadata', async () => {
    const bundle = await bundleEntrypoint('packages/sdk/src/browser-knowledge.ts');

    expect(bundle).not.toContain('homeassistant.homeGraph');
    expect(bundle).not.toContain('/api/homeassistant/home-graph');
    expect(bundle).toContain('companion.chat.sessions.create');
  });

  test('bundled agent entrypoint does not include Home Graph route metadata', async () => {
    const bundle = await bundleEntrypoint('packages/sdk/src/browser-agent.ts');

    expect(bundle).not.toContain('homeassistant.homeGraph');
    expect(bundle).not.toContain('/api/homeassistant/home-graph');
    expect(bundle).not.toContain('/api/knowledge/ask');
    expect(bundle).toContain('/api/goodvibes-agent/knowledge');
    expect(bundle).toContain('/ask');
  });

  test('bundled home assistant entrypoint does not include base knowledge/wiki contract metadata', async () => {
    const bundle = await bundleEntrypoint('packages/sdk/src/browser-homeassistant.ts');

    expect(bundle).not.toContain('knowledge.ask');
    expect(bundle).not.toContain('knowledge.refinement.tasks.list');
    expect(bundle).not.toContain('/api/knowledge/ask');
    expect(bundle).not.toContain('/api/knowledge/projections');
  });
});
