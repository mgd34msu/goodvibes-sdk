// line-cap-rule.ts
//
// Pure ratchet logic for the 800-line source-file cap. Kept separate from
// check-line-cap.ts (the filesystem-walking CLI)
// so the ratchet semantics can be exercised directly from tests with plain
// in-memory fixtures — no disk I/O required.
//
// Ratchet semantics:
//   - A file with NO grandfather entry is held to the hard cap: fails if it
//     exceeds MAX_SOURCE_LINES.
//   - A file WITH a grandfather entry may sit above MAX_SOURCE_LINES, but
//     never above its own recorded `ceiling`. Growing past the ceiling fails.
//   - A file WITH a grandfather entry whose current line count has dropped
//     below MAX_SOURCE_LINES no longer needs grandfathering — the entry is
//     stale and the check fails until it is removed. This stops the ratchet
//     list from silently outliving the violations it was recorded for.
//   - A grandfather entry whose file was not seen at all in the scanned set
//     (deleted or renamed) is also stale, for the same reason.

export const MAX_SOURCE_LINES = 800;

export interface GrandfatherEntry {
  /** The file's line count at the moment it was grandfathered. Shrink-only. */
  readonly ceiling: number;
  /** One-line human justification for why this file is still over cap. */
  readonly justification: string;
}

export interface FileLineCount {
  /** Repo-relative path, forward-slash normalized. */
  readonly relPath: string;
  readonly lineCount: number;
}

export function checkLineCap(
  files: readonly FileLineCount[],
  grandfather: Readonly<Record<string, GrandfatherEntry>>,
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const { relPath, lineCount } of files) {
    const entry = grandfather[relPath];

    if (!entry) {
      if (lineCount > MAX_SOURCE_LINES) {
        violations.push(
          `${relPath}: exceeds the ${MAX_SOURCE_LINES}-line cap (${lineCount} lines); ` +
            `split the file, or add a justified entry to line-cap-grandfather.ts`,
        );
      }
      continue;
    }

    seen.add(relPath);

    if (lineCount > entry.ceiling) {
      violations.push(
        `${relPath}: grew past its grandfathered ceiling of ${entry.ceiling} lines ` +
          `(now ${lineCount}); grandfather entries are shrink-only — split the file back ` +
          `under ${entry.ceiling} lines, or lower the ceiling only if the growth was ` +
          `deliberate and re-justified`,
      );
      continue;
    }

    if (lineCount < MAX_SOURCE_LINES) {
      violations.push(
        `${relPath}: is now ${lineCount} lines, under the ${MAX_SOURCE_LINES}-line cap, but ` +
          `still has a grandfather entry (ceiling ${entry.ceiling}); remove the entry from ` +
          `line-cap-grandfather.ts`,
      );
    }
  }

  for (const relPath of Object.keys(grandfather)) {
    if (seen.has(relPath)) continue;
    violations.push(
      `${relPath}: has a grandfather entry but was not found among scanned source files ` +
        `(deleted or renamed); remove the entry from line-cap-grandfather.ts`,
    );
  }

  return violations;
}
