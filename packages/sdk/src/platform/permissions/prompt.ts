import type { PermissionCategory, PermissionRequestAnalysis } from './types.js';

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
  analysis: PermissionRequestAnalysis;
  workingDirectory?: string | undefined;
}

export interface PermissionPromptDecision {
  approved: boolean;
  remember?: boolean | undefined;
}

export type PermissionRequestHandler = (
  request: PermissionPromptRequest,
) => Promise<PermissionPromptDecision>;

export interface PermissionRequest extends PermissionPromptRequest {
  resolve: (approved: boolean, remember?: boolean) => void;
}
