/**
 * changelog-gate — asserts CHANGELOG.md carries a section for a version.
 *
 * Supports both heading conventions in the estate: `## [1.2.3]` (SDK/TUI
 * bracketed) and `## 1.2.3` (agent plain). Pure over injected text.
 */

export type ChangelogHeading = 'bracket' | 'plain' | 'either';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the anchored header matcher for a version under the given convention. */
export function changelogHeaderPattern(version: string, heading: ChangelogHeading): RegExp {
  const v = escapeRegExp(version);
  if (heading === 'bracket') return new RegExp(`^##\\s*\\[${v}\\]`, 'm');
  if (heading === 'plain') return new RegExp(`^##\\s*${v}(?:\\s|$|-)`, 'm');
  return new RegExp(`^##\\s*(?:\\[${v}\\]|${v}(?:\\s|$|-))`, 'm');
}

/** True when `changelog` contains a section for `version`. */
export function hasChangelogSection(changelog: string, version: string, heading: ChangelogHeading = 'either'): boolean {
  return changelogHeaderPattern(version, heading).test(changelog);
}

export interface ChangelogGateResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** Gate a changelog for a version; returns a structured result (no process exit). */
export function runChangelogGate(changelog: string, version: string, heading: ChangelogHeading = 'either'): ChangelogGateResult {
  const ok = hasChangelogSection(changelog, version, heading);
  return {
    ok,
    detail: ok
      ? `CHANGELOG contains a section for ${version}`
      : `CHANGELOG is missing a section for ${version}. Add a "## ${heading === 'plain' ? version : `[${version}]`} - YYYY-MM-DD" heading before releasing.`,
  };
}
