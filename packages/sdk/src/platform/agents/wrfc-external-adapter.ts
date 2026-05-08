import type { WrfcState } from './wrfc-types.js';

export type WrfcExternalWorkStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface WrfcExternalWorkRequest {
  task: string;
  wrfcId?: string | undefined;
  chainState?: WrfcState | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface WrfcExternalWorkHandle {
  externalTaskId: string;
  status: WrfcExternalWorkStatus;
  metadata?: Record<string, unknown> | undefined;
}

export interface WrfcExternalWorkSnapshot extends WrfcExternalWorkHandle {
  progress?: string | undefined;
  updatedAt?: string | undefined;
}

export interface WrfcExternalWorkResult {
  externalTaskId: string;
  status: Extract<WrfcExternalWorkStatus, 'completed' | 'failed' | 'cancelled'>;
  summary: string;
  output?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Translation seam for limited surfaces and partner apps that cannot or should
 * not embed the native WRFC controller. TUI remains the first-class SDK-native
 * WRFC implementation; this adapter shape is for companion surfaces that need
 * to dispatch, poll, cancel, and normalize externally-owned work.
 */
export interface WrfcExternalWorkAdapter {
  dispatch(request: WrfcExternalWorkRequest): Promise<WrfcExternalWorkHandle>;
  status(externalTaskId: string): Promise<WrfcExternalWorkSnapshot>;
  cancel(externalTaskId: string, reason?: string | undefined): Promise<void>;
  result(externalTaskId: string): Promise<WrfcExternalWorkResult>;
}

export class WrfcExternalWorkBridge {
  constructor(private readonly adapter: WrfcExternalWorkAdapter) {}

  dispatch(request: WrfcExternalWorkRequest): Promise<WrfcExternalWorkHandle> {
    return this.adapter.dispatch(request);
  }

  status(externalTaskId: string): Promise<WrfcExternalWorkSnapshot> {
    return this.adapter.status(externalTaskId);
  }

  cancel(externalTaskId: string, reason?: string | undefined): Promise<void> {
    return this.adapter.cancel(externalTaskId, reason);
  }

  result(externalTaskId: string): Promise<WrfcExternalWorkResult> {
    return this.adapter.result(externalTaskId);
  }
}
