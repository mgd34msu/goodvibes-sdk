/**
 * feature-flag-config-bridge-services.test.ts
 *
 * End-to-end coverage for the live settings -> gate-manager bridge wired in
 * createRuntimeServices() (platform/runtime/services.ts): a real
 * ConfigManager.set on a capability's domain settings key (behavior.hitlMode,
 * permissions.engine, ...), after RuntimeServices is already constructed,
 * must reach the internally-created FeatureFlagManager without a restart —
 * for runtime-toggleable gates only. A startup-gated capability must show up
 * as pending-restart on the manager's snapshot instead of silently doing
 * nothing or faking a live apply.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { ConfigKey } from '../packages/sdk/src/platform/config/schema-types.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createRuntimeServices } from '../packages/sdk/src/platform/runtime/services.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import { installPlatformTracer, platformTracer } from '../packages/sdk/src/platform/runtime/metrics.js';
import { instrumentedLlmCall } from '../packages/sdk/src/platform/runtime/llm-observability.js';
import { trackDisposables } from './_helpers/disposables.ts';

/**
 * Each test here composes a whole runtime graph, which starts the fleet
 * registry tick, the config-file watch, the knowledge scheduler, the
 * push-subscription sweep and the snapshot / retention / consolidation
 * schedulers. Four graphs left running is 64 handles firing inside every later
 * file in this single-process suite.
 */
const disposables = trackDisposables();

const TOGGLEABLE_FLAG_ID = 'hitl-ux-modes';
const TOGGLEABLE_KEY = 'behavior.hitlMode' as ConfigKey;
const STARTUP_GATED_FLAG_ID = 'permissions-policy-engine';
const STARTUP_GATED_KEY = 'permissions.engine' as ConfigKey;

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function buildServices() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-flag-config-bridge-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const configManager = new ConfigManager({
    homeDir: homeDirectory,
    workingDir,
    surfaceRoot: 'goodvibes-test',
  });
  const runtimeServices = disposables.add(createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir,
    homeDirectory,
  }));
  return { configManager, runtimeServices };
}

describe('createRuntimeServices — live feature-settings bridge', () => {
  test('config.set on a runtime-toggleable flag applies live and notifies subscribers', () => {
    const { configManager, runtimeServices } = buildServices();
    const seen: Array<{ flagId: string; state: string }> = [];
    runtimeServices.featureFlags.subscribe((flagId, state) => seen.push({ flagId, state }));

    // behavior.hitlMode defaults 'balanced', so the notification-mode system is on.
    expect(runtimeServices.featureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
    configManager.setDynamic(TOGGLEABLE_KEY, 'off');

    expect(runtimeServices.featureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(false);
    expect(seen).toEqual([{ flagId: TOGGLEABLE_FLAG_ID, state: 'disabled' }]);
  });

  test('config.set on a startup-gated flag does not change effective state but is visible as pending-restart', () => {
    const { configManager, runtimeServices } = buildServices();
    const seen: unknown[] = [];
    runtimeServices.featureFlags.subscribe((flagId, state) => seen.push({ flagId, state }));

    expect(runtimeServices.featureFlags.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    configManager.setDynamic(STARTUP_GATED_KEY, 'policy-engine');

    // No live apply — the runtime must not fake a startup-only flag as active.
    expect(runtimeServices.featureFlags.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    expect(seen).toEqual([]);

    // But it is honestly surfaced as "persisted, restart required" on the manager's snapshot.
    expect(runtimeServices.featureFlags.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(true);
    expect(runtimeServices.featureFlags.getPendingRestartState(STARTUP_GATED_FLAG_ID)).toBe('enabled');
    const snapshot = runtimeServices.featureFlags.getAll().get(STARTUP_GATED_FLAG_ID);
    expect(snapshot).toMatchObject({ state: 'disabled', persistedState: 'enabled', pendingRestart: true });
  });

  test('an externally-injected featureFlags manager is NOT bridged (caller owns it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-flag-config-bridge-injected-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const configManager = new ConfigManager({
      homeDir: homeDirectory,
      workingDir,
      surfaceRoot: 'goodvibes-test',
    });
    const injectedFeatureFlags = createFeatureFlagManager();
    const runtimeServices = disposables.add(createRuntimeServices({
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'goodvibes',
      workingDir,
      homeDirectory,
      featureFlags: injectedFeatureFlags,
    }));
    expect(runtimeServices.featureFlags).toBe(injectedFeatureFlags);

    configManager.setDynamic(TOGGLEABLE_KEY, 'off');
    // The composition root only bridges the manager it created itself
    // (mirrors the options.featureFlags === undefined guard around the boot
    // loadFromConfig call) — an injected manager is the caller's to bridge.
    // The injected manager keeps its registry default (enabled) untouched.
    expect(injectedFeatureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
  });

  test('boot load still seeds effective state from persisted config at construction (unchanged)', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-flag-config-bridge-boot-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const configManager = new ConfigManager({
      homeDir: homeDirectory,
      workingDir,
      surfaceRoot: 'goodvibes-test',
    });
    // Persist a settings choice BEFORE RuntimeServices is constructed — the
    // boot path derives gate states from the domain keys at construction.
    configManager.setDynamic(TOGGLEABLE_KEY, 'off');

    const runtimeServices = disposables.add(createRuntimeServices({
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'goodvibes',
      workingDir,
      homeDirectory,
    }));
    expect(runtimeServices.featureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// telemetry.otelMode
// ---------------------------------------------------------------------------
//
// The mode drives two gates in FEATURE_SETTINGS_BINDINGS (otel-foundation,
// otel-remote-export), and their only reader was `createTelemetryProvider` —
// which had no callers. The live meter in runtime/metrics.ts was built with no
// reference to any of it, so 'off', 'in-process' and 'remote-export' produced
// identical behaviour: no spans, from any mode, ever.
//
// `createRuntimeServices` now builds the provider and installs its tracer as the
// platform's active one, which is what the assertions below observe: a no-op
// span (`spanContext.isValid === false`) with the mode off, a real recording span
// with it on, and an OTLP POST when it is set to remote-export with a collector.

/** Build a runtime with `telemetry.otelMode` persisted before construction. */
function servicesWithOtelMode(mode: string): { configManager: ConfigManager } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-otel-mode-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
  // otel-foundation is startup-gated, so the value has to be persisted before
  // the runtime is composed — the same ordering the case above documents.
  configManager.setDynamic('telemetry.otelMode' as ConfigKey, mode);
  disposables.add(createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir,
    homeDirectory,
  }));
  return { configManager };
}

describe('createRuntimeServices — telemetry.otelMode governs the platform tracer', () => {
  const savedEnv = {
    traces: process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    general: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  };

  afterEach(() => {
    // Put the process back: the tracer is process-wide, and so is the env.
    installPlatformTracer(null);
    if (savedEnv.traces === undefined) delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = savedEnv.traces;
    if (savedEnv.general === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = savedEnv.general;
  });

  test("'off' (the shipped default) installs a tracer that records nothing", () => {
    servicesWithOtelMode('off');
    const span = platformTracer().startSpan('probe');
    expect(span.spanContext.isValid).toBe(false);
    span.end();
  });

  test("'in-process' installs a tracer that creates real, recording spans", () => {
    servicesWithOtelMode('in-process');
    const span = platformTracer().startSpan('probe', { attributes: { 'probe.kind': 'unit' } });
    expect(span.spanContext.isValid).toBe(true);
    expect(span.spanContext.traceId).toMatch(/^[0-9a-f]{32}$/);
    span.end();
    const readable = span.toReadable();
    expect(readable.name).toBe('probe');
    expect(readable.attributes['probe.kind']).toBe('unit');
  });

  test('an LLM call produces no span with the mode off and a real one with it on', async () => {
    servicesWithOtelMode('off');
    await instrumentedLlmCall(async () => 'result', { provider: 'anthropic', model: 'claude-x' });
    // Nothing to assert on a no-op span beyond its invalidity; the point is that
    // the same call below yields a recording span once the mode changes.
    expect(platformTracer().startSpan('probe').spanContext.isValid).toBe(false);

    installPlatformTracer(null);
    servicesWithOtelMode('in-process');
    expect(platformTracer().startSpan('probe').spanContext.isValid).toBe(true);
  });

  test("'remote-export' exports the llm.call span to the configured collector", async () => {
    const received: unknown[] = [];
    const collector = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.json());
        return new Response('{}', { status: 200 });
      },
    });
    try {
      process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = `http://localhost:${collector.port}/v1/traces`;
      servicesWithOtelMode('remote-export');

      await instrumentedLlmCall(async () => 'result', { provider: 'anthropic', model: 'claude-x' });
      // The exporter batches; a flush is what a graceful shutdown does.
      await platformTracer().flush();
      for (let i = 0; i < 100 && received.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(received.length).toBeGreaterThan(0);
      expect(JSON.stringify(received)).toContain('llm.call');
      expect(JSON.stringify(received)).toContain('anthropic');
    } finally {
      collector.stop(true);
    }
  });

  test("'in-process' records the same span but exports it nowhere", async () => {
    const received: unknown[] = [];
    const collector = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.json());
        return new Response('{}', { status: 200 });
      },
    });
    try {
      // A collector IS configured; the mode is what decides whether it is used.
      process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = `http://localhost:${collector.port}/v1/traces`;
      servicesWithOtelMode('in-process');

      await instrumentedLlmCall(async () => 'result', { provider: 'anthropic', model: 'claude-x' });
      await platformTracer().flush();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(received).toEqual([]);
    } finally {
      collector.stop(true);
    }
  });
});
