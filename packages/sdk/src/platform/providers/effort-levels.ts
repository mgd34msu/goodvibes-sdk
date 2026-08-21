/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared effort level descriptions used across model picker, overlay renderer,
 * and command handler. Single source of truth, import from here.
 *
 * One line per level on the severity ladder in `reasoning-effort.ts`. A model
 * offers some subset of these, so a surface looks up only the levels its
 * resolved spec actually lists; a missing entry means this table has no line
 * for that level, not that the level is unavailable.
 */
export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none:    'Reasoning off, answers directly',
  instant: 'Fastest, minimal reasoning',
  minimal: 'A brief pass of reasoning',
  low:     'Quick with light reasoning',
  medium:  'Balanced speed and quality',
  high:    'Thorough, deep reasoning',
  xhigh:   'Deeper than high, slower',
  max:     'Deepest this model allows',
};
