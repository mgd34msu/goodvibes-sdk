/**
 * integration-helpers-surface-scope.test.ts — IntegrationHelperService can be
 * constructed with a `SessionSurface`.
 *
 * Defect class: `getContinuitySnapshot()` always called checkRecoveryFile /
 * readLastSessionPointer with the loose `workingDirectory` / `homeDirectory`
 * pair the service was constructed with. A product that writes surface-scoped
 * (`<work>/.goodvibes/<surface>/…`) and then asked the integration helper for
 * continuity got its answers from the unscoped legacy directories — paths
 * nothing had written to — which is how the consuming TUI's /health continuity
 * reported an empty pointer against a live session.
 *
 * The service now takes either shape, mutually exclusively, and routes every
 * persistence call through whichever it was given.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  IntegrationHelperService,
  type IntegrationHelpersServices,
} from '../packages/sdk/src/platform/runtime/integration/helpers.ts';
import {
  getRecoveryFilePath,
  writeLastSessionPointer,
  writeRecoveryFile,
} from '../packages/sdk/src/platform/runtime/session-persistence.ts';
import { createSessionSurface, type SessionSurface } from '../packages/sdk/src/platform/runtime/session-surface.ts';

const roots: string[] = [];

function tempDirs(): { workingDirectory: string; homeDirectory: string } {
  const base = join(tmpdir(), `gv-helper-scope-${randomUUID()}`);
  const workingDirectory = join(base, 'work');
  const homeDirectory = join(base, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  roots.push(base);
  return { workingDirectory, homeDirectory };
}

/**
 * The non-scope half of the context. Only `runtimeStore` is actually reached
 * by the calls under test; the rest exists to satisfy the shape.
 */
function stubServices(): IntegrationHelpersServices {
  return {
    runtimeStore: {
      getState: () => ({
        session: { id: 'live-session', status: 'idle', recoveryState: 'none' },
      }),
    },
  } as unknown as IntegrationHelpersServices;
}

function surfaceScoped(surface: SessionSurface): IntegrationHelperService {
  return new IntegrationHelperService({ ...stubServices(), surface });
}

function legacyScoped(workingDirectory: string, homeDirectory: string): IntegrationHelperService {
  return new IntegrationHelperService({ ...stubServices(), workingDirectory, homeDirectory });
}

/** Stamp a snapshot old enough that the offer stops reading it as live state. */
function abandon(path: string): void {
  const at = new Date(Date.now() - 600_000);
  utimesSync(path, at, at);
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('IntegrationHelperService: surface-scoped construction', () => {
  test('continuity reads the SURFACE paths a surface-scoped product writes to', () => {
    const { workingDirectory, homeDirectory } = tempDirs();
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });

    // Write exactly the way a surface-scoped product does.
    writeLastSessionPointer('surface-session', { surface });
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'crash tail' }] },
      'surface-session',
      'Surface Work',
      { surface },
    );
    // getContinuitySnapshot reports whether a snapshot would be OFFERED, so it
    // has to be old enough that no live writer is implied.
    abandon(surface.recoveryFile('surface-session'));

    const continuity = surfaceScoped(surface).getContinuitySnapshot();
    expect(continuity.lastSessionPointer).toBe('surface-session');
    expect(continuity.recoveryFilePresent).toBe(true);
    expect(continuity.recoveryFile?.sessionId).toBe('surface-session');
    expect(continuity.recoveryFile?.title).toBe('Surface Work');
    expect(continuity.sessionId).toBe('live-session');
  });

  test('a surface-scoped service does not answer from the unscoped legacy paths', () => {
    const { workingDirectory, homeDirectory } = tempDirs();
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });

    // Written to the LEGACY (unscoped) location only — a different file from
    // `<work>/.goodvibes/tui/sessions/last-session.json`.
    writeLastSessionPointer('legacy-session', { workingDirectory, homeDirectory });

    expect(surfaceScoped(surface).getContinuitySnapshot().lastSessionPointer).toBeNull();
  });

  test('the working directory comes off the surface (no separate field is required)', () => {
    const { workingDirectory, homeDirectory } = tempDirs();
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });

    // getWorktreeSnapshot is the other consumer of the project root; under
    // surface construction it must resolve rather than read `undefined`.
    const snapshot = surfaceScoped(surface).getWorktreeSnapshot();
    expect(Array.isArray(snapshot.records)).toBe(true);
    expect(snapshot.summary).toBeDefined();
  });
});

describe('IntegrationHelperService: legacy construction is unchanged', () => {
  test('continuity still reads the legacy unscoped paths', () => {
    const { workingDirectory, homeDirectory } = tempDirs();
    writeLastSessionPointer('legacy-session', { workingDirectory, homeDirectory });
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'legacy tail' }] },
      'legacy-session',
      'Legacy Work',
      { workingDirectory, homeDirectory },
    );
    abandon(getRecoveryFilePath(homeDirectory, 'legacy-session'));

    const continuity = legacyScoped(workingDirectory, homeDirectory).getContinuitySnapshot();
    expect(continuity.lastSessionPointer).toBe('legacy-session');
    expect(continuity.recoveryFilePresent).toBe(true);
    expect(continuity.recoveryFile?.sessionId).toBe('legacy-session');
    expect(continuity.recoveryFile?.title).toBe('Legacy Work');
  });

  test('a legacy-scoped service does not answer from a surface-scoped write', () => {
    const { workingDirectory, homeDirectory } = tempDirs();
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
    writeLastSessionPointer('surface-session', { surface });

    expect(legacyScoped(workingDirectory, homeDirectory).getContinuitySnapshot().lastSessionPointer).toBeNull();
  });
});
