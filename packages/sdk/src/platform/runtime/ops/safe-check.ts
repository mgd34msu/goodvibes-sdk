/**
 * Shared diagnostic check safety wrapper.
 *
 * Runs a diagnostic check function and catches any unexpected errors,
 * returning a structured failure result instead of throwing.
 */
import type { DiagnosticCheckResult } from './types.js';
import { summarizeError } from '../../utils/error-display.js';

export async function safeCheck(
  fn: () => Promise<DiagnosticCheckResult>,
): Promise<DiagnosticCheckResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      passed: false,
      summary: `Diagnostic check failed while collecting evidence: ${summarizeError(err)}`,
      severity: 'error',
    };
  }
}
