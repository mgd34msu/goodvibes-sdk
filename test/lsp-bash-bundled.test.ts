import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LspService } from '../packages/sdk/src/_internal/platform/intelligence/lsp/service.ts';
import { createShellPathService } from '../packages/sdk/src/_internal/platform/runtime/shell-paths.ts';

describe('bundled Bash LSP', () => {
  test('resolves and starts bash-language-server from the SDK package install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-bash-lsp-'));
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const service = new LspService(paths);

    try {
      service.registerServer('bash', { command: 'bash-language-server', args: ['start'] });

      expect(await service.isAvailable('bash')).toBe(true);
      const client = await service.getClient('bash');
      expect(client?.isRunning).toBe(true);
    } finally {
      await service.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
