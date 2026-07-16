/**
 * Injectable effect boundaries.
 *
 * Every tool is a policy function that takes its effects as parameters, so unit
 * tests drive it with in-memory stubs (no network, no real git mutation, no
 * child processes). The thin bins wire the real Node/Bun implementations.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Result of running a subprocess. */
export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a subprocess to completion and returns captured output. Never throws on non-zero exit. */
export type Exec = (command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }) => ExecResult;

/** Minimal read-only filesystem seam. */
export interface FsReader {
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly readDir: (path: string) => readonly string[];
  readonly isExecutable: (path: string) => boolean;
}

/** An HTTP GET returning a parsed JSON body plus the transport status. */
export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}
export type HttpGetJson = (url: string, headers: Readonly<Record<string, string>>) => Promise<HttpResponse>;

/** Structured logger seam (tests capture lines; bins print to console). */
export interface Logger {
  readonly info: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly error: (line: string) => void;
}

/** Sleep seam so pollers are deterministic in tests. */
export type Sleep = (ms: number) => Promise<void>;

/** Real subprocess runner: captures stdout/stderr, reports the exit status without throwing. */
export const realExec: Exec = (command, args, options = {}) => {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
};

/** Real filesystem reader rooted at an absolute base directory. */
export function realFsReader(root: string): FsReader {
  const at = (path: string): string => resolve(root, path);
  return {
    exists: (path) => existsSync(at(path)),
    readText: (path) => readFileSync(at(path), 'utf8'),
    readDir: (path) => readdirSync(at(path)),
    isExecutable: (path) => {
      try {
        return (statSync(at(path)).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
  };
}

/** Real HTTP GET returning parsed JSON. Non-2xx does not throw — the status is reported so callers can branch (e.g. 503 fallback). */
export const realHttpGetJson: HttpGetJson = async (url, headers) => {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

/** Console-backed logger. */
export const consoleLogger: Logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** In-memory logger for tests. */
export function captureLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
}

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
