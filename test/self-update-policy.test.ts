/**
 * The platform's one binary-update mechanism: checksum discipline,
 * all-verified-before-any-write, atomic swap with a kept previous version,
 * and one-command rollback. All I/O mocked; no network, no real files.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyVerifiedUpdate,
  compareVersions,
  parseChecksumFile,
  parseReleaseTagFromLocation,
  PREVIOUS_FILE_SUFFIX,
  resolveArtifactNames,
  resolveLatestReleaseTag,
  resolveSqliteVecAsset,
  rollbackKeptPrevious,
  sha256,
  swapFileAtomically,
  verifyChecksum,
  type UpdateFetchLike,
  type UpdateFileIo,
} from '../packages/sdk/src/platform/runtime/self-update.js';

/** In-memory filesystem recording every operation in order. */
function memoryIo(initial: Record<string, Buffer> = {}) {
  const files = new Map<string, Buffer>(Object.entries(initial));
  const operations: string[] = [];
  const io: UpdateFileIo = {
    writeFile: (path, data) => {
      operations.push(`write ${path}`);
      files.set(path, data);
    },
    rename: (from, to) => {
      operations.push(`rename ${from} -> ${to}`);
      const data = files.get(from);
      if (data === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    chmod: (path, mode) => {
      operations.push(`chmod ${path} ${mode.toString(8)}`);
    },
    exists: (path) => files.has(path),
    mkdir: (path) => {
      operations.push(`mkdir ${path}`);
    },
  };
  return { files, operations, io };
}

function fetchStub(routes: Record<string, string | Buffer | { status: number }>): UpdateFetchLike {
  return async (url) => {
    const found = routes[url];
    if (found === undefined) {
      return {
        ok: false, status: 404, url, headers: { get: () => null },
        text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (typeof found === 'object' && !Buffer.isBuffer(found)) {
      return {
        ok: false, status: found.status, url, headers: { get: () => null },
        text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const buffer = Buffer.isBuffer(found) ? found : Buffer.from(found);
    return {
      ok: true, status: 200, url, headers: { get: () => null },
      text: async () => buffer.toString('utf-8'),
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
  };
}

describe('release-artifact naming + checksums', () => {
  test('artifact names cover linux/macos x64/arm64 and refuse everything else', () => {
    expect(resolveArtifactNames('linux', 'x64')).toEqual({ app: 'goodvibes-linux-x64', daemon: 'goodvibes-daemon-linux-x64' });
    expect(resolveArtifactNames('darwin', 'arm64')).toEqual({ app: 'goodvibes-macos-arm64', daemon: 'goodvibes-daemon-macos-arm64' });
    expect(resolveArtifactNames('win32', 'x64')).toBeNull();
    expect(resolveArtifactNames('linux', 'ia32')).toBeNull();
  });

  test('the vector addon keeps the Node-style platform tag', () => {
    expect(resolveSqliteVecAsset('linux', 'arm64')).toEqual({
      assetName: 'sqlite-vec-linux-arm64.so',
      dirName: 'sqlite-vec-linux-arm64',
      fileName: 'vec0.so',
    });
    expect(resolveSqliteVecAsset('darwin', 'x64')?.assetName).toBe('sqlite-vec-darwin-x64.dylib');
    expect(resolveSqliteVecAsset('win32', 'x64')).toBeNull();
  });

  test('checksum manifest parsing tolerates asterisks and blank lines', () => {
    const digest = sha256(Buffer.from('payload'));
    const parsed = parseChecksumFile(`\n${digest}  file-a\n${digest} *file-b\n\nnot a checksum line\n`);
    expect(parsed.get('file-a')).toBe(digest);
    expect(parsed.get('file-b')).toBe(digest);
    expect(parsed.size).toBe(2);
  });

  test('a missing manifest entry is as fatal as a mismatch', () => {
    const digest = sha256(Buffer.from('payload'));
    expect(() => verifyChecksum('artifact', digest, undefined)).toThrow(/no checksum entry/);
    expect(() => verifyChecksum('artifact', digest, sha256(Buffer.from('other')))).toThrow(/checksum mismatch/);
    expect(() => verifyChecksum('artifact', digest, digest)).not.toThrow();
  });
});

describe('version + release tag resolution', () => {
  test('compareVersions treats a leading v and missing components as equal forms', () => {
    expect(compareVersions('1.2', 'v1.2.0')).toBe(0);
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('v2.0.0', '1.99.99')).toBe(1);
  });

  test('resolveLatestReleaseTag reads the redirect Location header and refuses silence', async () => {
    const latest = 'https://example.test/releases/latest';
    const withRedirect: UpdateFetchLike = async (url) => ({
      ok: false, status: 302, url,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://example.test/releases/tag/v9.9.9' : null) },
      text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(await resolveLatestReleaseTag(withRedirect, latest)).toBe('v9.9.9');
    expect(parseReleaseTagFromLocation('https://example.test/releases/tag/v1.0.0/')).toBe('v1.0.0');

    const silent: UpdateFetchLike = async (url) => ({
      ok: true, status: 200, url, headers: { get: () => null },
      text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(resolveLatestReleaseTag(silent, latest)).rejects.toThrow(/could not resolve the latest release tag/);
  });
});

describe('atomic swap with kept previous', () => {
  test('swap writes beside the target, parks the outgoing file at .previous, then renames over', () => {
    const { files, operations, io } = memoryIo({ '/opt/gv/daemon': Buffer.from('old') });
    swapFileAtomically('/opt/gv/daemon', Buffer.from('new'), { executable: true, io, platform: 'linux' });
    expect(files.get('/opt/gv/daemon')?.toString()).toBe('new');
    expect(files.get(`/opt/gv/daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('old');
    expect(operations).toEqual([
      'mkdir /opt/gv',
      'write /opt/gv/daemon.update-download',
      'chmod /opt/gv/daemon.update-download 755',
      `rename /opt/gv/daemon -> /opt/gv/daemon${PREVIOUS_FILE_SUFFIX}`,
      'rename /opt/gv/daemon.update-download -> /opt/gv/daemon',
    ]);
  });

  test('a non-executable target gets 644 and a fresh install skips the parking rename', () => {
    const { files, operations, io } = memoryIo();
    swapFileAtomically('/opt/gv/lib/vec0.so', Buffer.from('addon'), { executable: false, io, platform: 'linux' });
    expect(files.get('/opt/gv/lib/vec0.so')?.toString()).toBe('addon');
    expect(operations).toContain('chmod /opt/gv/lib/vec0.so.update-download 644');
    expect(operations.some((op) => op.includes(PREVIOUS_FILE_SUFFIX))).toBe(false);
  });
});

describe('applyVerifiedUpdate: all artifacts verify before any write', () => {
  const base = 'https://example.test/releases/download/v2.0.0';
  const daemonBuffer = Buffer.from('daemon-v2');
  const appBuffer = Buffer.from('app-v2');

  test('a checksum failure on the second artifact leaves zero files touched', async () => {
    const manifest = `${sha256(daemonBuffer)}  goodvibes-daemon-linux-x64\n${sha256(Buffer.from('tampered'))}  goodvibes-linux-x64\n`;
    const { files, operations, io } = memoryIo({ '/opt/gv/goodvibes-daemon': Buffer.from('old-daemon'), '/opt/gv/goodvibes': Buffer.from('old-app') });
    await expect(applyVerifiedUpdate({
      fetchImpl: fetchStub({
        [`${base}/SHA256SUMS.txt`]: manifest,
        [`${base}/goodvibes-daemon-linux-x64`]: daemonBuffer,
        [`${base}/goodvibes-linux-x64`]: appBuffer,
      }),
      downloadBaseUrl: base,
      targets: [
        { label: 'daemon binary', path: '/opt/gv/goodvibes-daemon', assetName: 'goodvibes-daemon-linux-x64', executable: true },
        { label: 'app binary', path: '/opt/gv/goodvibes', assetName: 'goodvibes-linux-x64', executable: true },
      ],
      io,
      platform: 'linux',
    })).rejects.toThrow(/checksum mismatch/);
    expect(operations).toEqual([]);
    expect(files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('old-daemon');
    expect(files.get('/opt/gv/goodvibes')?.toString()).toBe('old-app');
  });

  test('a fully verified pair swaps both, each with a kept previous', async () => {
    const manifest = `${sha256(daemonBuffer)}  goodvibes-daemon-linux-x64\n${sha256(appBuffer)}  goodvibes-linux-x64\n`;
    const { files, io } = memoryIo({ '/opt/gv/goodvibes-daemon': Buffer.from('old-daemon'), '/opt/gv/goodvibes': Buffer.from('old-app') });
    await applyVerifiedUpdate({
      fetchImpl: fetchStub({
        [`${base}/SHA256SUMS.txt`]: manifest,
        [`${base}/goodvibes-daemon-linux-x64`]: daemonBuffer,
        [`${base}/goodvibes-linux-x64`]: appBuffer,
      }),
      downloadBaseUrl: base,
      targets: [
        { label: 'daemon binary', path: '/opt/gv/goodvibes-daemon', assetName: 'goodvibes-daemon-linux-x64', executable: true },
        { label: 'app binary', path: '/opt/gv/goodvibes', assetName: 'goodvibes-linux-x64', executable: true },
      ],
      io,
      platform: 'linux',
    });
    expect(files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
    expect(files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('old-daemon');
    expect(files.get('/opt/gv/goodvibes')?.toString()).toBe('app-v2');
    expect(files.get(`/opt/gv/goodvibes${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('old-app');
  });
});

describe('one-command rollback', () => {
  test('rollback EXCHANGES live and kept files, so a second rollback rolls forward again', () => {
    const { files, io } = memoryIo({
      '/opt/gv/goodvibes-daemon': Buffer.from('v2'),
      [`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`]: Buffer.from('v1'),
    });
    const targets = [{ label: 'daemon binary', path: '/opt/gv/goodvibes-daemon' }];

    const first = rollbackKeptPrevious(targets, io);
    expect(first.restored).toHaveLength(1);
    expect(files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('v1');
    expect(files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('v2');

    const second = rollbackKeptPrevious(targets, io);
    expect(second.restored).toHaveLength(1);
    expect(files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('v2');
    expect(files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('v1');
  });

  test('targets without a kept previous are reported and left untouched', () => {
    const { files, io } = memoryIo({ '/opt/gv/goodvibes': Buffer.from('only') });
    const result = rollbackKeptPrevious([{ label: 'app binary', path: '/opt/gv/goodvibes' }], io);
    expect(result.restored).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(files.get('/opt/gv/goodvibes')?.toString()).toBe('only');
  });
});
