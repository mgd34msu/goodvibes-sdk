import type { FetchSanitizeMode } from './schema.js';

export interface FetchUrlResult {
  url: string;
  status?: number | undefined;
  statusText?: string | undefined;
  contentType?: string | undefined;
  byteSize?: number | undefined;
  content?: string | undefined;
  error?: string | undefined;
  truncated?: boolean | undefined;
  from_cache?: boolean | undefined;
  redirected?: boolean | undefined;
  final_url?: string | undefined;
  duration_ms?: number | undefined;
  tokens_used?: number | undefined;
  sanitization_tier?: FetchSanitizeMode | 'skipped' | undefined;
  host_trust_tier?: string | undefined;
  metadata?: {
    headers: Record<string, string>;
    redirected: boolean;
    finalUrl: string;
  };
}

export interface FetchOutput {
  success: boolean;
  error?: string | undefined;
  results?: FetchUrlResult[] | undefined;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    total_ms?: number | undefined;
  };
}
