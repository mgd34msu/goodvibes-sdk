import type { FetchExtractMode } from '../tools/fetch/schema.js';

export type WebSearchVerbosity = 'urls_only' | 'titles' | 'snippets' | 'evidence' | 'full';
export type WebSearchSafeSearch = 'strict' | 'moderate' | 'off';
export type WebSearchTimeRange = 'any' | 'day' | 'week' | 'month' | 'year';
export type WebSearchResultType = 'organic' | 'instant_answer' | 'related_topic';
export type WebSearchProviderCapability = 'search' | 'instant_answer' | 'evidence';

export interface WebSearchEvidence {
  readonly url: string;
  readonly extract: FetchExtractMode;
  readonly content: string;
  readonly tokensUsed: number;
  readonly status?: number | undefined;
  readonly contentType?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchResult {
  readonly rank: number;
  readonly url: string;
  readonly title?: string | undefined;
  readonly snippet?: string | undefined;
  readonly displayUrl?: string | undefined;
  readonly domain?: string | undefined;
  readonly type: WebSearchResultType;
  readonly providerId: string;
  readonly metadata: Record<string, unknown>;
  readonly evidence?: readonly WebSearchEvidence[] | undefined;
}

export interface WebSearchRelatedTopic {
  readonly text: string;
  readonly url: string;
}

export interface WebSearchInstantAnswer {
  readonly heading?: string | undefined;
  readonly answer?: string | undefined;
  readonly abstract?: string | undefined;
  readonly source?: string | undefined;
  readonly url?: string | undefined;
  readonly image?: string | undefined;
  readonly type: string;
  readonly related: readonly WebSearchRelatedTopic[];
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly providerId?: string | undefined;
  readonly maxResults?: number | undefined;
  readonly verbosity?: WebSearchVerbosity | undefined;
  readonly region?: string | undefined;
  readonly safeSearch?: WebSearchSafeSearch | undefined;
  readonly timeRange?: WebSearchTimeRange | undefined;
  readonly includeInstantAnswer?: boolean | undefined;
  readonly includeEvidence?: boolean | undefined;
  readonly evidenceTopN?: number | undefined;
  readonly evidenceExtract?: FetchExtractMode | undefined;
  readonly trustedHosts?: readonly string[] | undefined;
  readonly blockedHosts?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface WebSearchProviderResponse {
  readonly results: readonly WebSearchResult[];
  readonly instantAnswer?: WebSearchInstantAnswer | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchResponse {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly query: string;
  readonly verbosity: WebSearchVerbosity;
  readonly results: readonly WebSearchResult[];
  readonly instantAnswer?: WebSearchInstantAnswer | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly WebSearchProviderCapability[];
  readonly requiresAuth: boolean;
  readonly configured: boolean;
  readonly note?: string | undefined;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly WebSearchProviderCapability[];
  descriptor?(): WebSearchProviderDescriptor;
  search(request: WebSearchRequest): Promise<WebSearchProviderResponse>;
}
