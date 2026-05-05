import type { ToolResult } from '../../../types/tools.js';

/**
 * Adds a phase warning to the structured result and to the text the model sees.
 */
export function attachVisibleToolWarning(result: ToolResult | undefined, warning: string): void {
  if (!result) return;

  const currentWarnings = result.warnings ?? [];
  result.warnings = [...currentWarnings, warning];

  const visibleWarning = `[Warning: ${warning}]`;
  if (result.success) {
    result.output = prependVisibleWarning(result.output, visibleWarning);
  } else {
    result.error = prependVisibleWarning(result.error, visibleWarning);
  }
}

function prependVisibleWarning(value: string | undefined, warning: string): string {
  if (!value || value.length === 0) return warning;
  return `${warning}\n${value}`;
}
