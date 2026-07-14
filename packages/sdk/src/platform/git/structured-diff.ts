/**
 * structured-diff.ts — parse raw `git diff` output into a complete, structured
 * form consumers render with their diff-view machinery.
 *
 * The old consumer path for `/git diff` sliced the raw text at 4,000 chars and
 * printed the stub. This module is the SDK-side replacement: the FULL diff is
 * parsed into per-file entries with per-hunk lines — no size cap anywhere — so
 * a surface renders it structurally (per-file, per-hunk, colored lines) and the
 * truncation branch dies. `reconstructUnifiedDiff` proves the structure is
 * complete: parse → reconstruct round-trips the original text.
 */

/** One line inside a hunk. */
export interface StructuredDiffLine {
  /** 'context' (unchanged), 'add' (+), or 'del' (-). */
  readonly kind: 'context' | 'add' | 'del';
  /** The line content WITHOUT its +/-/space prefix. */
  readonly text: string;
}

/** One @@ hunk: header coordinates plus every line, unabridged. */
export interface StructuredDiffHunk {
  /** The raw `@@ -a,b +c,d @@ ...` header line. */
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly StructuredDiffLine[];
}

/** One file's diff: paths, status, and every hunk, unabridged. */
export interface StructuredDiffFile {
  /** Path before the change (null for an added file). */
  readonly oldPath: string | null;
  /** Path after the change (null for a deleted file). */
  readonly newPath: string | null;
  readonly status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  readonly hunks: readonly StructuredDiffHunk[];
  /** The file-header lines exactly as emitted (diff --git, index, ---/+++, etc.). */
  readonly headerLines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

/** The whole diff, structured, with honest totals. Never truncated. */
export interface StructuredDiff {
  readonly files: readonly StructuredDiffFile[];
  readonly additions: number;
  readonly deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// git's path prefixes: the conventional a/ b/ plus the mnemonicPrefix set
// (c=commit, i=index, w=working tree, o=object). Tolerates --no-prefix.
const DIFF_PATH_PREFIX = /^[abciow]\//;

function stripPathPrefix(raw: string): string {
  return DIFF_PATH_PREFIX.test(raw) ? raw.slice(2) : raw;
}

function parsePath(line: string, prefix: string): string | null {
  const raw = line.slice(prefix.length).trim();
  if (raw === '/dev/null') return null;
  return stripPathPrefix(raw);
}

/**
 * Parse raw unified-diff text (any size — no cap) into structured files/hunks.
 * Unknown leading material and binary-file notices are handled; an empty diff
 * yields zero files.
 */
export function parseUnifiedDiff(raw: string): StructuredDiff {
  const files: StructuredDiffFile[] = [];
  if (!raw.trim()) return { files, additions: 0, deletions: 0 };
  const lines = raw.split('\n');
  // Drop a single trailing empty element produced by a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  interface Building {
    headerLines: string[];
    oldPath: string | null;
    newPath: string | null;
    binary: boolean;
    renamed: boolean;
    hunks: Array<{ header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: StructuredDiffLine[] }>;
  }
  let current: Building | null = null;

  const finalize = (): void => {
    if (!current) return;
    const additions = current.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === 'add').length, 0);
    const deletions = current.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === 'del').length, 0);
    const status: StructuredDiffFile['status'] = current.binary
      ? 'binary'
      : current.oldPath === null
        ? 'added'
        : current.newPath === null
          ? 'deleted'
          : current.renamed
            ? 'renamed'
            : 'modified';
    files.push({
      oldPath: current.oldPath,
      newPath: current.newPath,
      status,
      hunks: current.hunks,
      headerLines: current.headerLines,
      additions,
      deletions,
    });
    current = null;
  };

  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finalize();
      inHunk = false;
      // Fallback paths from the diff --git line itself (kept when ---/+++ follow).
      current = { headerLines: [line], oldPath: null, newPath: null, binary: false, renamed: false, hunks: [] };
      const paths = line.slice('diff --git '.length).split(' ');
      if (paths.length >= 2) {
        current.oldPath = stripPathPrefix(paths[0]!);
        current.newPath = stripPathPrefix(paths[1]!);
      }
      continue;
    }
    if (!current) {
      // Tolerate diffs that start directly with ---/+++ (no diff --git line).
      if (line.startsWith('--- ')) {
        current = { headerLines: [], oldPath: null, newPath: null, binary: false, renamed: false, hunks: [] };
        inHunk = false;
      } else {
        continue;
      }
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      inHunk = true;
      current.hunks.push({
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      });
      continue;
    }
    if (inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '' || line.startsWith('\\'))) {
      const hunk = current.hunks[current.hunks.length - 1]!;
      if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) hunk.lines.push({ kind: 'del', text: line.slice(1) });
      else if (line.startsWith('\\')) hunk.lines.push({ kind: 'context', text: line });
      else hunk.lines.push({ kind: 'context', text: line.slice(1) });
      continue;
    }
    // File-header territory (index/---/+++/rename/binary/mode lines).
    inHunk = false;
    current.headerLines.push(line);
    if (line.startsWith('--- ')) current.oldPath = parsePath(line, '--- ');
    else if (line.startsWith('+++ ')) current.newPath = parsePath(line, '+++ ');
    else if (line.startsWith('Binary files ')) current.binary = true;
    else if (line.startsWith('rename from ') || line.startsWith('rename to ')) current.renamed = true;
  }
  finalize();

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/**
 * Rebuild unified-diff text from the structure — the completeness proof used
 * by tests (parse → reconstruct round-trips byte-for-byte for text diffs) and
 * an escape hatch for consumers that still want raw text for one file.
 */
export function reconstructUnifiedDiff(diff: StructuredDiff): string {
  const out: string[] = [];
  for (const file of diff.files) {
    out.push(...file.headerLines);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        if (line.kind === 'add') out.push(`+${line.text}`);
        else if (line.kind === 'del') out.push(`-${line.text}`);
        else if (line.text.startsWith('\\')) out.push(line.text);
        else out.push(` ${line.text}`);
      }
    }
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
}
