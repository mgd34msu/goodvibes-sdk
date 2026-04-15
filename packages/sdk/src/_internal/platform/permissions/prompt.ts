import type { PermissionCategory, PermissionRequestAnalysis } from '@pellux/goodvibes-sdk/platform/permissions/types';

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
  analysis: PermissionRequestAnalysis;
  workingDirectory?: string;
}

export interface PermissionPromptDecision {
  approved: boolean;
  remember?: boolean;
}

export type PermissionRequestHandler = (
  request: PermissionPromptRequest,
) => Promise<PermissionPromptDecision>;

export interface PermissionRequest extends PermissionPromptRequest {
  resolve: (approved: boolean, remember?: boolean) => void;
}
