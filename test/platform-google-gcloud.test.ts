/**
 * Tests for the gcloud driver (google-gcloud.ts). Every scenario is driven
 * through a fake GoogleCommandPort that returns recorded gcloud-shaped JSON
 * payloads, no real gcloud, no real network, no real Google account.
 */
import { describe, expect, test } from 'bun:test';
import type { GoogleCommandPort, GoogleCommandResult } from '../packages/sdk/src/platform/google/types.ts';
import {
  checkAuthenticated,
  detectGcloud,
  enabledServices,
  enableServices,
  installGcloud,
  listProjects,
  selectOrCreateProject,
} from '../packages/sdk/src/platform/google/gcloud.ts';

const HOME = '/home/test-user';
const FALLBACK_GCLOUD = `${HOME}/google-cloud-sdk/bin/gcloud`;

function okResult(stdout = ''): GoogleCommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false, spawnError: null };
}
function failResult(stderr = 'boom'): GoogleCommandResult {
  return { code: 1, stdout: '', stderr, timedOut: false, spawnError: null };
}
function spawnFailResult(): GoogleCommandResult {
  return { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn ENOENT' };
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function fakePort(
  script: (command: string, args: readonly string[]) => GoogleCommandResult,
): GoogleCommandPort & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return script(command, args);
    },
  };
}

describe('detectGcloud', () => {
  test('reports not found when gcloud is missing from PATH and the home fallback', async () => {
    const port = fakePort(() => spawnFailResult());
    const result = await detectGcloud(port, HOME);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('not on PATH');
      expect(result.fix.length).toBeGreaterThan(0);
    }
  });

  test('finds gcloud at the home-directory fallback path when it is absent from PATH', async () => {
    const port = fakePort((command) => {
      if (command === 'gcloud') return spawnFailResult();
      if (command === FALLBACK_GCLOUD) return okResult('Google Cloud SDK 123.0.0\nbq 2.1.0');
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await detectGcloud(port, HOME);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(FALLBACK_GCLOUD);
      expect(result.version).toBe('Google Cloud SDK 123.0.0');
    }
  });

  test('prefers gcloud on PATH over the home fallback when both would work', async () => {
    const port = fakePort((command) => {
      if (command === 'gcloud') return okResult('Google Cloud SDK 500.0.0');
      return okResult('Google Cloud SDK 123.0.0');
    });
    const result = await detectGcloud(port, HOME);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe('gcloud');
  });
});

describe('installGcloud', () => {
  test('is idempotent: skips download and install when the binary already exists', async () => {
    const port = fakePort((command) => {
      if (command === FALLBACK_GCLOUD) return okResult('Google Cloud SDK 123.0.0');
      throw new Error(`unexpected command during already-installed check: ${command}`);
    });
    const result = await installGcloud(port, { homeDirectory: HOME });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('already-installed');
      expect(result.path).toBe(FALLBACK_GCLOUD);
    }
    expect(port.calls).toHaveLength(1);
  });

  test('downloads, extracts, and installs into the home directory when gcloud is missing', async () => {
    let installed = false;
    const port = fakePort((command, args) => {
      if (command === FALLBACK_GCLOUD) {
        return installed ? okResult('Google Cloud SDK 123.0.0') : spawnFailResult();
      }
      if (command === 'curl') return okResult('');
      if (command === 'tar') return okResult('');
      if (command === `${HOME}/google-cloud-sdk/install.sh`) {
        expect(args).toContain('--quiet');
        installed = true;
        return okResult('');
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });
    const result = await installGcloud(port, { homeDirectory: HOME });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('installed');
      expect(result.path).toBe(FALLBACK_GCLOUD);
    }
    const commands = port.calls.map((call) => call.command);
    expect(commands).toContain('curl');
    expect(commands).toContain('tar');
    expect(commands).toContain(`${HOME}/google-cloud-sdk/install.sh`);
  });

  test('reports a clear problem when the download step fails', async () => {
    const port = fakePort((command) => {
      if (command === FALLBACK_GCLOUD) return spawnFailResult();
      if (command === 'curl') return failResult('curl: (6) Could not resolve host');
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await installGcloud(port, { homeDirectory: HOME });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('Downloading');
      expect(result.fix.length).toBeGreaterThan(0);
    }
  });
});

describe('checkAuthenticated', () => {
  test('returns the active account when gcloud auth list reports one', async () => {
    const port = fakePort(() =>
      okResult(JSON.stringify([{ account: 'someone@example.com', status: 'ACTIVE' }])),
    );
    const result = await checkAuthenticated(port, 'gcloud');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account).toBe('someone@example.com');
  });

  test('reports no active account when the list has none marked ACTIVE', async () => {
    const port = fakePort(() =>
      okResult(JSON.stringify([{ account: 'someone@example.com', status: 'INACTIVE' }])),
    );
    const result = await checkAuthenticated(port, 'gcloud');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fix).toContain('gcloud auth login');
  });

  test('reports a clear problem when gcloud auth list output is not parseable JSON', async () => {
    const port = fakePort(() => okResult('WARNING: some noise\nnot json at all'));
    const result = await checkAuthenticated(port, 'gcloud');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('parse');
  });

  test('tolerates a stderr warning line mixed onto stdout around the JSON body', async () => {
    const port = fakePort(() =>
      okResult('WARNING: legacy format\n[{"account":"someone@example.com","status":"ACTIVE"}]\n'),
    );
    const result = await checkAuthenticated(port, 'gcloud');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account).toBe('someone@example.com');
  });
});

describe('listProjects', () => {
  test('parses the project list', async () => {
    const port = fakePort(() =>
      okResult(JSON.stringify([{ projectId: 'goodvibes-agent-abc123', name: 'goodvibes agent' }])),
    );
    const result = await listProjects(port, 'gcloud');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.projectId).toBe('goodvibes-agent-abc123');
    }
  });

  test('reports a clear problem on malformed JSON', async () => {
    const port = fakePort(() => okResult('{not valid json'));
    const result = await listProjects(port, 'gcloud');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('parse');
  });
});

describe('selectOrCreateProject', () => {
  test('reuses an existing project whose id starts with the preferred prefix', async () => {
    const port = fakePort((command, args) => {
      if (args[0] === 'projects' && args[1] === 'list') {
        return okResult(JSON.stringify([{ projectId: 'goodvibes-agent-abc123' }]));
      }
      throw new Error(`should not reach create: ${command} ${args.join(' ')}`);
    });
    const result = await selectOrCreateProject(port, 'gcloud', { preferredPrefix: 'goodvibes-agent' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('reused');
      expect(result.projectId).toBe('goodvibes-agent-abc123');
    }
    expect(port.calls.some((call) => call.args.includes('create'))).toBe(false);
  });

  test('creates a new project with the preferred prefix when none exists yet', async () => {
    const port = fakePort((command, args) => {
      if (args[0] === 'projects' && args[1] === 'list') return okResult(JSON.stringify([]));
      if (args[0] === 'projects' && args[1] === 'create') return okResult(JSON.stringify({ done: true }));
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });
    const result = await selectOrCreateProject(port, 'gcloud', { preferredPrefix: 'goodvibes-agent' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('created');
      expect(result.projectId.startsWith('goodvibes-agent-')).toBe(true);
    }
  });

  test('never creates a second project on a re-run once one already exists', async () => {
    const port = fakePort((command, args) => {
      if (args[0] === 'projects' && args[1] === 'list') {
        return okResult(JSON.stringify([{ projectId: 'goodvibes-agent-existing' }]));
      }
      throw new Error(`re-run must not create: ${command} ${args.join(' ')}`);
    });
    const first = await selectOrCreateProject(port, 'gcloud', { preferredPrefix: 'goodvibes-agent' });
    const second = await selectOrCreateProject(port, 'gcloud', { preferredPrefix: 'goodvibes-agent' });
    expect(first.ok && first.outcome).toBe('reused');
    expect(second.ok && second.outcome).toBe('reused');
  });
});

describe('enabledServices', () => {
  test('parses enabled services from either config.name or name shape', async () => {
    const port = fakePort(() =>
      okResult(
        JSON.stringify([{ config: { name: 'gmail.googleapis.com' } }, { name: 'calendar-json.googleapis.com' }]),
      ),
    );
    const result = await enabledServices(port, 'gcloud', 'my-project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.services).toContain('gmail.googleapis.com');
      expect(result.services).toContain('calendar-json.googleapis.com');
    }
  });

  test('reports a clear problem on malformed JSON', async () => {
    const port = fakePort(() => okResult('not json'));
    const result = await enabledServices(port, 'gcloud', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('parse');
  });
});

describe('enableServices', () => {
  test('enables only the services that are missing and reports what was already on', async () => {
    const port = fakePort((command, args) => {
      if (args[0] === 'services' && args[1] === 'list') {
        return okResult(JSON.stringify([{ config: { name: 'gmail.googleapis.com' } }]));
      }
      if (args[0] === 'services' && args[1] === 'enable') {
        expect(args).toContain('calendar-json.googleapis.com');
        expect(args).not.toContain('gmail.googleapis.com');
        return okResult('');
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });
    const result = await enableServices(port, 'gcloud', 'my-project', [
      'gmail.googleapis.com',
      'calendar-json.googleapis.com',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.enabled).toEqual(['calendar-json.googleapis.com']);
      expect(result.alreadyEnabled).toEqual(['gmail.googleapis.com']);
    }
  });

  test('is idempotent: issues no enable command when every service is already on', async () => {
    const port = fakePort((command, args) => {
      if (args[0] === 'services' && args[1] === 'list') {
        return okResult(
          JSON.stringify([{ config: { name: 'gmail.googleapis.com' } }, { config: { name: 'calendar-json.googleapis.com' } }]),
        );
      }
      throw new Error(`should not enable anything: ${command} ${args.join(' ')}`);
    });
    const result = await enableServices(port, 'gcloud', 'my-project', [
      'gmail.googleapis.com',
      'calendar-json.googleapis.com',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.enabled).toEqual([]);
      expect(result.alreadyEnabled).toEqual(['gmail.googleapis.com', 'calendar-json.googleapis.com']);
    }
    expect(port.calls.some((call) => call.args.includes('enable'))).toBe(false);
  });
});
