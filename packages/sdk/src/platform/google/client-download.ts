/**
 * Picking up the OAuth client JSON the console just downloaded.
 *
 * Google names the file `client_secret_<id>.apps.googleusercontent.com.json`,
 * so matching on filename is fragile and matching on an exact name is simply
 * wrong. The browser tool owns the profile the download landed in, so the flow
 * already knows the directory — what it needs is to identify the right file by
 * **content shape**: a JSON object with an `installed` key carrying both
 * `client_id` and `client_secret`.
 *
 * When collection fails the flow asks for a path rather than stalling. A
 * question the user can answer in five seconds is always better than a silent
 * wait, which is the failure mode this whole integration exists to eliminate.
 */

/** Directory listing and file reading, injected so this is testable. */
export interface DownloadScanPort {
  listFiles(directory: string): readonly string[];
  readText(path: string): string | null;
  /** Modification time in epoch milliseconds; used only to prefer the newest match. */
  modifiedAtMs(path: string): number | null;
}

export interface CollectedClientFile {
  readonly path: string;
  readonly contents: string;
}

export type CollectClientFileResult =
  | { readonly ok: true; readonly file: CollectedClientFile }
  | { readonly ok: false; readonly problem: string; readonly fix: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this text look like a Desktop-app OAuth client JSON?
 *
 * Checks structure, not name. A `web` client is deliberately not accepted —
 * it cannot complete the loopback flow, and silently picking one up would
 * produce a baffling failure several steps later.
 */
export function looksLikeDesktopClientJson(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.installed)) return false;
  const installed = parsed.installed;
  return typeof installed.client_id === 'string' && typeof installed.client_secret === 'string';
}

/**
 * Find the most recently modified Desktop-client JSON in a download directory.
 *
 * `since` lets the caller ignore files that predate this walkthrough, so a
 * stale client JSON downloaded months ago is never picked up in place of the
 * one just created.
 */
export function collectDownloadedClientFile(
  scan: DownloadScanPort,
  directory: string,
  options: { readonly since?: number } = {},
): CollectClientFileResult {
  let candidates: readonly string[];
  try {
    candidates = scan.listFiles(directory);
  } catch {
    candidates = [];
  }

  const matches: { path: string; contents: string; modifiedAtMs: number }[] = [];
  for (const path of candidates) {
    if (!path.toLowerCase().endsWith('.json')) continue;
    const contents = scan.readText(path);
    if (contents === null || !looksLikeDesktopClientJson(contents)) continue;
    const modifiedAtMs = scan.modifiedAtMs(path) ?? 0;
    if (options.since !== undefined && modifiedAtMs < options.since) continue;
    matches.push({ path, contents, modifiedAtMs });
  }

  if (matches.length === 0) {
    return {
      ok: false,
      problem: `No downloaded OAuth client JSON was found in ${directory}.`,
      fix: 'If the browser saved it somewhere else, re-run with the path to the downloaded JSON file. In the Google Cloud console the file is offered by "Download JSON" on the client you just created.',
    };
  }

  // Newest wins: a user who created the client twice wants the latest one.
  matches.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const best = matches[0];
  if (best === undefined) {
    return {
      ok: false,
      problem: `No downloaded OAuth client JSON was found in ${directory}.`,
      fix: 'Re-run with the path to the downloaded JSON file.',
    };
  }
  return { ok: true, file: { path: best.path, contents: best.contents } };
}
