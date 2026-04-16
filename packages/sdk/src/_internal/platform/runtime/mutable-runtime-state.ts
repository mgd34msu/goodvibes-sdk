/**
 * Mutable runtime state that host shells can update in response to command,
 * model-picker, and resume flows without replacing a larger runtime object.
 */
export interface MutableRuntimeState {
  model: string;
  provider: string;
  debugMode: boolean;
  systemPrompt: string;
  /** Empty string if not configured. */
  reasoningEffort: string;
  sessionId: string;
}
