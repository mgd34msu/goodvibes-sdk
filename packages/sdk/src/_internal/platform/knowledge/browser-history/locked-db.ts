import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface LockedBrowserDbCopy {
  readonly copiedDbPath: string;
  readonly tempDir: string;
  cleanup(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyLockedBrowserSqlite(sourcePath: string): Promise<LockedBrowserDbCopy> {
  if (!(await exists(sourcePath))) {
    throw new Error(`Browser SQLite file does not exist: ${sourcePath}`);
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'goodvibes-browser-db-'));
  const baseName = basename(sourcePath);
  const copiedDbPath = join(tempDir, baseName);
  await copyFile(sourcePath, copiedDbPath);

  for (const suffix of ['-wal', '-shm']) {
    const source = `${sourcePath}${suffix}`;
    if (await exists(source)) {
      await copyFile(source, join(tempDir, `${baseName}${suffix}`));
    }
  }

  let cleaned = false;
  return {
    copiedDbPath,
    tempDir,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

