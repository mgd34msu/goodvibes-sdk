import type { FsReader, Exec, ExecResult, HttpGetJson, HttpResponse } from '@pellux/goodvibes-toolchain';

/** Build an in-memory FsReader from a path→content map. Executable paths are listed separately. */
export function fakeFs(files: Record<string, string>, executable: readonly string[] = []): FsReader {
  const exec = new Set(executable);
  const dirs = new Map<string, Set<string>>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/');
      const child = parts[i + 1];
      if (!child) continue;
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir)!.add(child);
    }
    // top-level entries live under '' + first segment
    const first = parts[0];
    if (first && parts.length === 1) {
      if (!dirs.has('.')) dirs.set('.', new Set());
      dirs.get('.')!.add(first);
    }
  }
  return {
    exists: (p) => p in files || dirs.has(p),
    readText: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
    readDir: (p) => {
      const set = dirs.get(p);
      if (!set) throw new Error(`ENOTDIR: ${p}`);
      return [...set];
    },
    isExecutable: (p) => exec.has(p),
  };
}

/** Build an Exec stub that returns scripted results keyed by the first arg (or command). */
export function scriptedExec(handler: (command: string, args: readonly string[]) => Partial<ExecResult>): Exec {
  return (command, args) => ({ status: 0, stdout: '', stderr: '', ...handler(command, args) });
}

/** Build an HttpGetJson stub from a queue or a URL matcher. */
export function scriptedHttp(handler: (url: string) => HttpResponse): HttpGetJson {
  return async (url) => handler(url);
}
