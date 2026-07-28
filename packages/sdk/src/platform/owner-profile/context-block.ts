/**
 * context-block.ts — the open tier, rendered for system context.
 *
 * docs/owner-profile.md §11.2 splits the profile in two. The OPEN tier is
 * useless if it has to be asked for and harmless in context, so it is rendered
 * here as a short block and injected once per turn. The CLOSED tier — his name,
 * every contact detail, his home address, everything commercial, how to reach
 * him, his defaults, and the People / Places / Work / Notes sections entirely —
 * is NEVER bulk-injected. That is what makes "an outbound message cannot leak
 * his home address" a structural fact rather than a hope: the address was never
 * in context to leak.
 *
 * `location.city` is open on purpose and `location.homeAddress` is closed. The
 * failure that prompted this whole feature was the agent guessing a metro area
 * for a weather answer; a city is not a doorstep.
 *
 * Two rules the call sites have to honour, and both have bitten this codebase
 * before:
 *
 *  1. **Compose, never write back.** The block is composed onto the base system
 *     prompt fresh for each model invocation and must not be stored into any
 *     cached base string, or it compounds once per tool round.
 *  2. **Absent means absent.** A profile that is disabled, unavailable or empty
 *     renders `''` and the caller appends nothing. It never renders a placeholder
 *     saying the profile could not be read — that would be prompt noise on every
 *     turn, and it would put the file path in front of the model for no reason.
 *
 * This module deliberately imports no Node built-in. It takes the reads it needs
 * as a structural type, so a caller with any source of those two methods can
 * render the block.
 */
import { PROFILE_FIELDS } from './fields.js';
import type { ProfileLine, ProfileLoadState, ProfileSection } from './types.js';

/** The reads the block needs. Satisfied by `OwnerProfileStore`. */
export interface OpenTierProfileSource {
  status(): ProfileLoadState;
  get(fieldId: string): { readonly value: string; readonly valid: boolean } | undefined;
  section(name: string): ProfileSection | undefined;
}

/** Sentence-case label for a field, e.g. `goes by` → `Goes by`. */
function labelOf(label: string): string {
  return label.length === 0 ? label : `${label[0]!.toUpperCase()}${label.slice(1)}`;
}

/** A line's text with a leading bullet marker removed, so the block renders one list. */
function bulletText(line: ProfileLine): string {
  return line.text.replace(/^\s*[-*+]\s+/, '').trim();
}

/**
 * The open tier as a short system-context block, or `''` when there is nothing
 * to say.
 *
 * Invalid values are skipped, exactly as an unset one would be: §4.3's rule is
 * that a value the parser could not make sense of is preserved in the file,
 * reported by `profile.status`, and treated by its consumer as absent. Putting
 * `timezone: Mars/Olympus` into context would be the one behaviour worse than
 * dropping it, because the model would then act on it.
 */
export function renderOpenTierBlock(source: OpenTierProfileSource): string {
  if (source.status().kind !== 'loaded') return '';

  const entries: string[] = [];
  for (const field of PROFILE_FIELDS) {
    if (field.tier !== 'open') continue;
    const value = source.get(field.id);
    if (value === undefined || !value.valid) continue;
    const trimmed = value.value.trim();
    if (trimmed.length === 0) continue;
    entries.push(`- ${labelOf(field.label)}: ${trimmed}`);
  }

  // All Style CONTENT is open, not just its two mechanical fields: §11.2 says
  // "all Style content", and a style note is exactly the kind of standing
  // instruction that is useless unless the model already has it.
  for (const line of source.section('Style')?.prose ?? []) {
    const text = bulletText(line);
    if (text.length > 0) entries.push(`- Style: ${text}`);
  }

  if (entries.length === 0) return '';
  return [
    '## About the person you are working for',
    'From his profile. Apply it; do not read it back to him unless he asks.',
    ...entries,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The seam the prompt assemblers read through
// ---------------------------------------------------------------------------

/** Renders the block for the process's one owner profile. `''` when there is none. */
export type OpenTierBlockSource = () => string;

let openTierSource: OpenTierBlockSource | null = null;

/**
 * Register (or clear, with `null`) the process's open-tier block source.
 *
 * A process-level registration rather than a dependency threaded through every
 * prompt assembler, for two reasons. There is exactly ONE owner profile per
 * machine — it is the daemon's file, not a per-session or per-agent object — so
 * there is nothing for a parameter to disambiguate. And the alternative, adding
 * a field to the orchestrator context types, would mean a wide diff across
 * files three other rounds are editing right now, to carry a value that is the
 * same everywhere it would arrive.
 *
 * The gate on `profile.injectOpenTier` lives in whatever registers the source
 * (see `owner-profile/consumers.ts`), so switching it off leaves this returning
 * `''` and the prompt assemblers appending nothing.
 */
export function registerOpenTierContextBlock(source: OpenTierBlockSource | null): void {
  openTierSource = source;
}

/**
 * The current block, or `''`.
 *
 * Called once per model invocation. With nothing registered — a surface with no
 * daemon, a test, a build where the profile is off — it is a null check and a
 * constant, which is what keeps this safe to call unconditionally from the hot
 * path of every turn.
 */
export function openTierContextBlock(): string {
  return openTierSource?.() ?? '';
}
