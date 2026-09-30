/**
 * daemon-smoke-turn.mjs, one scripted turn through a real daemon.
 *
 * Imports the SDK ONLY by package name, so the same file proves whichever
 * bytes resolve: the installed tarballs when scripts/packed-daemon-smoke.ts
 * copies it into a scratch consumer (CI and `bun run smoke:daemon`), or the
 * workspace dist when run in place (`bun run smoke:daemon --workspace`).
 *
 * The turn:
 *   1. a scripted OpenAI-compatible endpoint (Bun.serve on an ephemeral port)
 *      answers every chat completion with a fixed streamed reply;
 *   2. a custom provider file points the daemon at that endpoint;
 *   3. bootDaemon composes the full daemon (isolated home, ephemeral port,
 *      bearer token) exactly as an embedder would;
 *   4. over HTTP: create a companion chat session on the scripted model, post
 *      one message, and poll the transcript until the assistant answers.
 *
 * Passes only when the prompt reached the provider AND the scripted reply came
 * back into the session transcript through the daemon. Exits 1 otherwise, with
 * what was observed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { bootDaemon } from '@pellux/goodvibes-sdk/platform/daemon';

const PROMPT = 'Reply with the smoke words.';
const REPLY = 'packed daemon smoke reply: the turn went through';
const PROVIDER = 'smoke';
const MODEL = 'smoke-model';
const TOKEN = 'daemon-smoke-token';
const TURN_DEADLINE_MS = 60_000;

/** Every chat-completions body the scripted provider received. */
const received = [];

function sse(chunks) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.endsWith('/models')) {
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
    }
    if (pathname.endsWith('/chat/completions')) {
      received.push(await req.json());
      const base = { id: 'smoke-1', object: 'chat.completion.chunk', created: 0, model: MODEL };
      return new Response(sse([
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } },
      ]), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  },
});

const root = mkdtempSync(join(tmpdir(), 'goodvibes-daemon-smoke-'));
const home = join(root, 'home');
const work = join(root, 'work');
mkdirSync(home, { recursive: true });
mkdirSync(work, { recursive: true });

let daemon = null;
let failure = null;

function fail(message) {
  failure = message;
  throw new Error(message);
}

async function api(method, path, body) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

try {
  const configManager = new ConfigManager({
    workingDir: work,
    homeDir: home,
    surfaceRoot: 'goodvibes',
    ownsDaemonTier: true,
  });
  const providersDir = join(configManager.getControlPlaneConfigDir(), 'providers');
  mkdirSync(providersDir, { recursive: true });
  writeFileSync(join(providersDir, `${PROVIDER}.json`), JSON.stringify({
    name: PROVIDER,
    displayName: 'Daemon smoke (scripted)',
    type: 'openai-compat',
    baseURL: `http://127.0.0.1:${provider.port}/v1`,
    apiKey: 'smoke-key',
    models: [{
      id: MODEL,
      displayName: 'Smoke model',
      contextWindow: 32_768,
      selectable: true,
      capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    }],
  }, null, 2));

  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    configManager,
  });
  console.log(`[daemon-smoke] daemon up at ${daemon.url}; scripted provider at :${provider.port}`);

  const created = await api('POST', '/api/companion/chat/sessions', { title: 'smoke', provider: PROVIDER, model: MODEL });
  if (created.status !== 201 || !created.json?.sessionId) fail(`session create answered ${created.status}: ${created.text.slice(0, 300)}`);
  const sessionId = created.json.sessionId;

  const posted = await api('POST', `/api/companion/chat/sessions/${sessionId}/messages`, { content: PROMPT });
  if (posted.status >= 300) fail(`message post answered ${posted.status}: ${posted.text.slice(0, 300)}`);

  const deadline = Date.now() + TURN_DEADLINE_MS;
  let messages = [];
  for (;;) {
    const res = await api('GET', `/api/companion/chat/sessions/${sessionId}/messages`);
    messages = res.json?.messages ?? [];
    const assistant = messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0);
    if (assistant.length > 0) break;
    if (Date.now() > deadline) fail(`no assistant message within ${TURN_DEADLINE_MS} ms; transcript: ${JSON.stringify(messages).slice(0, 600)}`);
    await Bun.sleep(100);
  }

  const reached = received.some((body) => JSON.stringify(body.messages ?? []).includes(PROMPT));
  if (!reached) fail(`the prompt never reached the provider (${received.length} request(s) received)`);
  const answer = messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  if (!answer.includes(REPLY)) fail(`assistant message is not the scripted reply: ${answer.slice(0, 300)}`);

  console.log(`[daemon-smoke] PASS: prompt reached the scripted provider and the reply came back through session ${sessionId}`);
} catch (error) {
  if (failure === null) failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await daemon?.stop();
  provider.stop(true);
  rmSync(root, { recursive: true, force: true });
}

if (failure !== null) {
  console.error(`[daemon-smoke] FAIL: ${failure}`);
  process.exit(1);
}
process.exit(0);
