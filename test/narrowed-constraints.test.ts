/**
 * narrowed-constraints.test.ts
 *
 * Seven constraints that were applied one layer too wide, or hardcoded tables
 * that went stale. Each test asserts the REAL behaviour the narrowing is for,
 * that credentials are still masked, that unrelated env names still never
 * reach the wire, that a model's cap matches what the provider publishes,
 * rather than merely asserting the constraint is gone.
 *
 * The browser submit path is deliberately absent: its coarse taint branch was
 * reviewed and kept. See docs/decisions/2026-07-27-daemon-refuses-derived-sends.md
 * and test/browser-outward-effects.test.ts, which still contract the refusal.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  redactSensitiveData,
  redactCredentialsOnly,
} from '../packages/sdk/src/platform/utils/redaction.ts';
import { redactAtRestLine } from '../packages/sdk/src/platform/runtime/at-rest-persistence.ts';
import { upsertMcpServerConfig } from '../packages/sdk/src/platform/mcp/config.ts';
import { getCatalogModelDefinitionsFrom, modelCapabilityFactsFromCatalog } from '../packages/sdk/src/platform/providers/model-catalog.ts';
import type { CatalogModel } from '../packages/sdk/src/platform/providers/model-catalog.ts';
import { runResumeRepair } from '../packages/sdk/src/platform/runtime/compaction/resume-repair.ts';
import { CompactionManager } from '../packages/sdk/src/platform/runtime/compaction/manager.ts';
import type { BoundaryCommit } from '../packages/sdk/src/platform/runtime/compaction/types.ts';
import { ProviderCapabilityRegistry } from '../packages/sdk/src/platform/providers/capabilities.ts';
import { createCredentialStatusProvider } from '../packages/sdk/src/platform/config/credential-status.ts';
import { AnthropicProvider } from '../packages/sdk/src/platform/providers/anthropic.ts';

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-narrowed-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Not a real key, the shape the credential patterns look for, as a fixture. */
const FIXTURE_API_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';

// ───────────────────────────────────────────────────────────────────────────
// 2. The owner's own journal is no longer home-path anonymised
// ───────────────────────────────────────────────────────────────────────────

describe('at-rest redaction masks credentials without anonymising the owner', () => {
  test('a home path survives the at-rest writer intact', () => {
    const line = JSON.stringify({ cwd: '/home/mike/Projects/goodvibes-sdk' });
    const out = redactAtRestLine(line);
    // The whole point: the journal file LIVES in this directory. Rewriting it
    // to /home/[REDACTED]/... irreversibly, at write time, costs the entry the
    // one detail that makes it worth reading later and protects nobody.
    expect(out).toContain('/home/mike/Projects/goodvibes-sdk');
    expect(out).not.toContain('[REDACTED]');
  });

  test('a credential in the same line is still masked', () => {
    const line = JSON.stringify({
      cwd: '/home/mike/Projects/goodvibes-sdk',
      body: `run with ${FIXTURE_API_KEY} and Authorization: Bearer abcdef.ghijkl`,
    });
    const out = redactAtRestLine(line);
    expect(out).not.toContain(FIXTURE_API_KEY);
    expect(out).toContain('[REDACTED_API_KEY]');
    expect(out).toContain('[REDACTED_TOKEN]');
    // Still a parseable line, a redacted record must not become unreadable.
    expect(() => JSON.parse(out) as unknown).not.toThrow();
    // …and the path is still there alongside the masked secret.
    expect(out).toContain('/home/mike/Projects/goodvibes-sdk');
  });

  test('the EGRESS helper still anonymises, because that text leaves the machine', () => {
    // session-export goes to someone who is not the owner, so his account name
    // is not theirs to have. This is the call site the identity patterns exist
    // for, and it must keep both halves.
    const out = redactSensitiveData('/home/mike/Projects/x');
    expect(out).toBe('/home/[REDACTED]/Projects/x');
  });

  test('redactCredentialsOnly and redactSensitiveData agree on secrets, differ on identity', () => {
    const withSecret = `key ${FIXTURE_API_KEY} here`;
    expect(redactCredentialsOnly(withSecret)).toBe(redactSensitiveData(withSecret));
    expect(redactCredentialsOnly('/home/mike/x')).toBe('/home/mike/x');
    expect(redactSensitiveData('/home/mike/x')).toBe('/home/[REDACTED]/x');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. MCP env survives an upsert that does not mention it
// ───────────────────────────────────────────────────────────────────────────

describe('MCP upsert preserves env it was not asked to change', () => {
  function roots(dir: string) {
    return { workingDirectory: dir, homeDirectory: dir } as Parameters<typeof upsertMcpServerConfig>[0];
  }

  test('editing an unrelated field keeps the stored env', () => {
    const dir = mkTemp();
    const r = roots(dir);
    upsertMcpServerConfig(r, 'project', {
      name: 'billing',
      command: 'billing-mcp',
      env: { BILLING_TOKEN: 'secret-value', REGION: 'eu' },
    });

    // The admin changes an allowed host. They never saw the env values, the
    // read path only ever showed envKeys, so they could not have resent them.
    const after = upsertMcpServerConfig(r, 'project', {
      name: 'billing',
      command: 'billing-mcp',
      allowedHosts: ['api.billing.example'],
    });

    const stored = after.config.servers.find((s) => s.name === 'billing');
    expect(stored?.env).toEqual({ BILLING_TOKEN: 'secret-value', REGION: 'eu' });
    expect(stored?.allowedHosts).toEqual(['api.billing.example']);
  });

  test('supplying env still replaces it, so a variable can be removed', () => {
    const dir = mkTemp();
    const r = roots(dir);
    upsertMcpServerConfig(r, 'project', {
      name: 'billing',
      command: 'billing-mcp',
      env: { BILLING_TOKEN: 'secret-value', REGION: 'eu' },
    });
    const after = upsertMcpServerConfig(r, 'project', {
      name: 'billing',
      command: 'billing-mcp',
      env: { REGION: 'us' },
    });
    const stored = after.config.servers.find((s) => s.name === 'billing');
    // Explicit intent is honoured: an omitted key is not a delete, but a
    // supplied map is a full statement of what env should be.
    expect(stored?.env).toEqual({ REGION: 'us' });
  });

  test('a brand-new server with no env is stored with no env', () => {
    const dir = mkTemp();
    const after = upsertMcpServerConfig(roots(dir), 'project', { name: 'fresh', command: 'fresh-mcp' });
    expect(after.config.servers.find((s) => s.name === 'fresh')?.env).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Anthropic max output, the real published cap, live-first
// ───────────────────────────────────────────────────────────────────────────

describe('Anthropic max_tokens matches what the provider publishes', () => {
  /** Capture the outgoing request body without reaching the network. */
  async function capturedMaxTokens(model: string, requested: number): Promise<number> {
    const realFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    try {
      const provider = new AnthropicProvider('test-key-not-real');
      await provider.chat({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: requested,
      } as Parameters<AnthropicProvider['chat']>[0]);
    } finally {
      globalThis.fetch = realFetch;
    }
    return body['max_tokens'] as number;
  }

  test('claude-opus-5 gets its real 128000, not the 16384 default', async () => {
    // The live number, from Anthropic's published model comparison. Before the
    // table had an arm for it, this model fell through to ANTHROPIC_DEFAULT_
    // MAX_OUTPUT and was capped at an eighth of its capacity, silently.
    expect(await capturedMaxTokens('claude-opus-5', 200_000)).toBe(128_000);
  });

  test('sonnet-5 and fable-5 also get 128000', async () => {
    expect(await capturedMaxTokens('claude-sonnet-5', 200_000)).toBe(128_000);
    expect(await capturedMaxTokens('claude-fable-5', 200_000)).toBe(128_000);
  });

  test('haiku-4-5 gets 64000 — the table is corrected, not merely widened', async () => {
    expect(await capturedMaxTokens('claude-haiku-4-5', 200_000)).toBe(64_000);
  });

  test('a request under the cap is passed through unchanged', async () => {
    expect(await capturedMaxTokens('claude-opus-5', 4_096)).toBe(4_096);
  });

  test('a live /v1/models limit beats the offline table', async () => {
    const realFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/v1/models')) {
        // A model this build's table has never heard of, with a real cap.
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-future-9', max_tokens: 250_000, max_input_tokens: 2_000_000 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    try {
      const provider = new AnthropicProvider('test-key-not-real');
      await provider.refreshModels(true);
      await provider.chat({
        model: 'claude-future-9',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 400_000,
      } as Parameters<AnthropicProvider['chat']>[0]);
    } finally {
      globalThis.fetch = realFetch;
    }
    // Without the live read this model would fall to the 16384 default.
    expect(body['max_tokens']).toBe(250_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. multimodal comes from the model, not from the vendor
// ───────────────────────────────────────────────────────────────────────────

describe('multimodal is read per model rather than guessed by vendor', () => {
  function catalogModel(over: Partial<CatalogModel>): CatalogModel {
    return {
      id: 'm', name: 'M', provider: 'Test', providerId: 'test',
      providerEnvVars: [], pricing: null, tier: 'paid',
      ...over,
    } as CatalogModel;
  }

  test('an Anthropic vision model is multimodal, though no vendor rule allowed it', () => {
    const [def] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'claude-opus-5', provider: 'Anthropic', providerId: 'anthropic', inputModalities: ['text', 'image', 'pdf'] }),
    ]);
    expect(def!.capabilities.multimodal).toBe(true);
  });

  test('a text-only OpenAI model is not multimodal, though the vendor rule said it was', () => {
    const [def] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'text-embedding-3-large', provider: 'OpenAI', providerId: 'openai', inputModalities: ['text'] }),
    ]);
    expect(def!.capabilities.multimodal).toBe(false);
  });

  test('a Google vision model stays multimodal', () => {
    const [def] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'gemini-3-pro', provider: 'Google', providerId: 'google', inputModalities: ['text', 'image'] }),
    ]);
    expect(def!.capabilities.multimodal).toBe(true);
  });

  test('an entry carrying no modality block reports nothing rather than guessing', () => {
    const [def] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'mystery', provider: 'OpenAI', providerId: 'openai' }),
    ]);
    // A vendor-based fallback here would reintroduce exactly the bug.
    expect(def!.capabilities.multimodal).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Resume repair uses the real context window
// ───────────────────────────────────────────────────────────────────────────

describe('resume repair truncates against the real window', () => {
  /** A commit whose JSON is ~460k characters ≈ 115k estimated tokens. */
  function bigCommit(): BoundaryCommit {
    const filler = 'x'.repeat(5_000);
    const messages = Array.from({ length: 90 }, () => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: filler }],
    }));
    return {
      checkpointId: 'cpt_test', sessionId: 'sess_test', createdAt: Date.now(),
      strategy: 'summarize', parentCheckpointId: null, lineage: [],
      messages,
    } as unknown as BoundaryCommit;
  }

  test('the 80k fallback still truncates when no caller supplies a window', () => {
    const result = runResumeRepair({ commit: bigCommit() });
    expect(result.actions.some((a) => a.kind === 'truncate_overflow')).toBe(true);
  });

  test('a 1M-token window keeps every message the session could afford', () => {
    const result = runResumeRepair({ commit: bigCommit(), maxTokens: Math.floor(1_000_000 * 0.8) });
    expect(result.actions.some((a) => a.kind === 'truncate_overflow')).toBe(false);
    expect(result.messages).toHaveLength(90);
  });

  test('the manager passes its own contextWindow, so a 1M model keeps its messages', () => {
    // repair() reads only _lastCommit/override and _contextWindow, bus and
    // flags are never touched on this path, so minimal stubs are honest here.
    const stub = {} as unknown as ConstructorParameters<typeof CompactionManager>[0]['bus'];
    const manager = new CompactionManager({
      sessionId: 'sess_test',
      bus: stub,
      flags: {} as unknown as ConstructorParameters<typeof CompactionManager>[0]['flags'],
      contextWindow: 1_000_000,
    });
    const result = manager.repair(bigCommit());
    // Before the fix this discarded ~25 messages against a hardcoded 80_000,
    // on a model with room for more than ten times that.
    expect(result.actions.some((a) => a.kind === 'truncate_overflow')).toBe(false);
    expect(result.messages).toHaveLength(90);
  });

  test('a small window still truncates through the manager', () => {
    const manager = new CompactionManager({
      sessionId: 'sess_test',
      bus: {} as unknown as ConstructorParameters<typeof CompactionManager>[0]['bus'],
      flags: {} as unknown as ConstructorParameters<typeof CompactionManager>[0]['flags'],
      contextWindow: 100_000,
    });
    expect(manager.repair(bigCommit()).actions.some((a) => a.kind === 'truncate_overflow')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Capability overrides hold exceptions; the fleet comes from live data
// ───────────────────────────────────────────────────────────────────────────

describe('per-model capabilities come from catalog data', () => {
  const catalog: CatalogModel[] = [
    {
      id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'Anthropic', providerId: 'anthropic',
      providerEnvVars: [], pricing: null, tier: 'paid',
      contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true,
    } as CatalogModel,
    {
      id: 'mercury-2', name: 'Mercury 2', provider: 'InceptionLabs', providerId: 'inceptionlabs',
      providerEnvVars: [], pricing: null, tier: 'paid',
      contextWindow: 128_000, maxOutputTokens: 32_000, reasoning: true,
    } as CatalogModel,
  ];

  test('a current model gets real limits instead of the conservative default', () => {
    const registry = new ProviderCapabilityRegistry();
    const before = registry.getCapability('anthropic', 'claude-opus-5');
    // No per-model entry existed for any current model, so the whole fleet
    // landed on the provider-wide default, 8_192 output against a real
    // 128_000, and a 200_000 context against a real 1_000_000.
    expect(before.maxOutputTokens).toBe(8_192);
    expect(before.maxContextTokens).toBe(200_000);

    registry.setModelFactsSource(modelCapabilityFactsFromCatalog(catalog));
    const after = registry.getCapability('anthropic', 'claude-opus-5');
    expect(after.maxOutputTokens).toBe(128_000);
    expect(after.maxContextTokens).toBe(1_000_000);
    expect(after.reasoningControls).toBe(true);
  });

  test('setting the source invalidates what was resolved without it', () => {
    const registry = new ProviderCapabilityRegistry();
    registry.getCapability('anthropic', 'claude-opus-5');
    registry.setModelFactsSource(modelCapabilityFactsFromCatalog(catalog));
    // A stale cached record here would make the wiring inert in production.
    expect(registry.getCapability('anthropic', 'claude-opus-5').maxOutputTokens).toBe(128_000);
  });

  test('a genuine exception still outranks live data', () => {
    const registry = new ProviderCapabilityRegistry();
    registry.setModelFactsSource(modelCapabilityFactsFromCatalog(catalog));
    const mercury = registry.getCapability('inceptionlabs', 'mercury-2');
    // The catalog has no field for "this model cannot call tools at all", so a
    // generous limits record must not turn tool calling back on.
    expect(mercury.toolCalling).toBe(false);
    expect(mercury.parallelTools).toBe(false);
    expect(mercury.maxOutputTokens).toBe(32_000);
  });

  test('the offline fallback for Opus 4.5 is the published 64000, not the stale 32000', () => {
    const registry = new ProviderCapabilityRegistry();
    expect(registry.getCapability('anthropic', 'claude-opus-4-5').maxOutputTokens).toBe(64_000);
  });

  test('a model the source does not know falls through to the static table', () => {
    const registry = new ProviderCapabilityRegistry();
    registry.setModelFactsSource(modelCapabilityFactsFromCatalog(catalog));
    expect(registry.getCapability('openai', 'o3').maxOutputTokens).toBe(100_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 8. list() and get() agree about env-backed credentials
// ───────────────────────────────────────────────────────────────────────────

describe('credential status list covers env credentials without dumping the environment', () => {
  const secrets = {
    async listDetailed() {
      return [
        { key: 'STORED_KEY', source: 'project' as const, scope: 'project' as const, secure: true, overriddenByEnv: false },
        // A provider key configured only in the environment.
        { key: 'ANTHROPIC_API_KEY', source: 'env' as const, scope: 'env' as const, secure: false, overriddenByEnv: false },
        // The rest of the shell, which listDetailed also enumerates.
        { key: 'PATH', source: 'env' as const, scope: 'env' as const, secure: false, overriddenByEnv: false },
        { key: 'AWS_PROFILE', source: 'env' as const, scope: 'env' as const, secure: false, overriddenByEnv: false },
      ];
    },
    async list() { return []; },
    async get(key: string) { return key === 'PATH' || key === 'ANTHROPIC_API_KEY' || key === 'STORED_KEY' ? 'value' : null; },
  } as unknown as Parameters<typeof createCredentialStatusProvider>[0];

  test('an env-only provider key appears in list, matching what get already said', async () => {
    const provider = createCredentialStatusProvider(secrets);
    const keys = (await provider.list()).map((r) => r.key);
    expect(keys).toContain('ANTHROPIC_API_KEY');
    // get() always reported it configured; list() used to disagree, and list()
    // is what a setup screen renders.
    expect((await provider.get('ANTHROPIC_API_KEY'))?.configured).toBe(true);
  });

  test('unrelated environment variable names still never reach the wire', async () => {
    const keys = (await createCredentialStatusProvider(secrets).list()).map((r) => r.key);
    expect(keys).not.toContain('PATH');
    // AWS_PROFILE is not a credential name in the provider catalog, so it stays
    // invisible even though it looks credential-adjacent.
    expect(keys).not.toContain('AWS_PROFILE');
  });

  test('stored keys are still listed', async () => {
    const keys = (await createCredentialStatusProvider(secrets).list()).map((r) => r.key);
    expect(keys).toContain('STORED_KEY');
  });

  test('a key that is both stored and in env is listed once, as the stored record', async () => {
    const both = {
      async listDetailed() {
        return [
          { key: 'ANTHROPIC_API_KEY', source: 'project' as const, scope: 'project' as const, secure: true, overriddenByEnv: true },
          { key: 'ANTHROPIC_API_KEY', source: 'env' as const, scope: 'env' as const, secure: false, overriddenByEnv: false },
        ];
      },
      async list() { return []; },
      async get() { return 'value'; },
    } as unknown as Parameters<typeof createCredentialStatusProvider>[0];
    const records = (await createCredentialStatusProvider(both).list()).filter((r) => r.key === 'ANTHROPIC_API_KEY');
    expect(records).toHaveLength(1);
    expect(records[0]!.source).toBe('project');
    expect(records[0]!.overriddenByEnv).toBe(true);
  });
});
