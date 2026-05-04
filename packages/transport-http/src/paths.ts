import { ConfigurationError } from '@pellux/goodvibes-errors';

export interface TransportPaths {
  readonly baseUrl: string;
  readonly statusUrl: string;
  readonly controlPlaneUrl: string;
  readonly controlPlaneAuthUrl: string;
  readonly controlPlaneEventsUrl: string;
  readonly controlPlaneMethodsUrl: string;
  readonly sessionsUrl: string;
  readonly tasksUrl: string;
  readonly approvalsUrl: string;
  readonly providersUrl: string;
  readonly accountsUrl: string;
  readonly localAuthUrl: string;
  readonly telemetryUrl: string;
  readonly telemetryEventsUrl: string;
  readonly telemetryErrorsUrl: string;
  readonly telemetryTracesUrl: string;
  readonly telemetryMetricsUrl: string;
  readonly telemetryStreamUrl: string;
  readonly telemetryOtlpTracesUrl: string;
  readonly telemetryOtlpLogsUrl: string;
  readonly telemetryOtlpMetricsUrl: string;
  readonly remoteUrl: string;
  readonly remoteContractUrl: string;
  readonly peerRequestsUrl: string;
  readonly peerListUrl: string;
  readonly remoteWorkUrl: string;
  /**
   * Alias for `controlPlaneUrl`. Provided for convenience.
   */
  readonly controlUrl: string;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new ConfigurationError('Transport baseUrl is required. Pass a non-empty baseUrl string to your transport or SDK options.', { code: 'SDK_TRANSPORT_BASE_URL_REQUIRED' });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (cause) {
    throw new ConfigurationError('Transport baseUrl must be an absolute URL.', {
      code: 'SDK_TRANSPORT_BASE_URL_INVALID',
      source: 'transport',
      hint: 'Pass a full URL such as https://goodvibes.example.com.',
      cause,
    });
  }
  const protocol = parsed.protocol;
  if (protocol !== 'https:' && protocol !== 'wss:' && protocol !== 'http:' && protocol !== 'ws:') {
    throw new ConfigurationError(`Unsupported transport baseUrl protocol: ${protocol}`, {
      code: 'SDK_TRANSPORT_BASE_URL_PROTOCOL_UNSUPPORTED',
      source: 'transport',
      hint: 'Use https:// or wss://. http:// and ws:// are accepted only for local development or explicit insecure deployments.',
    });
  }
  const host = parsed.hostname.toLowerCase();
  const local = host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
  const runtimeProcess = (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }).process;
  const allowInsecure = runtimeProcess?.env?.GOODVIBES_ALLOW_INSECURE_TRANSPORT === 'true';
  if ((protocol === 'http:' || protocol === 'ws:') && !local && !allowInsecure) {
    throw new ConfigurationError('Refusing insecure non-local GoodVibes transport baseUrl.', {
      code: 'SDK_TRANSPORT_INSECURE_BASE_URL',
      source: 'transport',
      hint: 'Use https:// or wss://, or set GOODVIBES_ALLOW_INSECURE_TRANSPORT=true for an intentional non-local development deployment.',
    });
  }
  return normalized.replace(/\/+$/, '');
}

export function buildUrl(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/^[a-z][a-z0-9+\-.]*:/i.test(path)) {
    throw new ConfigurationError(`Absolute path not allowed: ${path}`, { code: 'SDK_TRANSPORT_PATH_ABSOLUTE' });
  }
  try {
    return new URL(path, `${normalized}/`).toString();
  } catch (cause) {
    throw new ConfigurationError(`Invalid transport path: ${path}`, { code: 'SDK_TRANSPORT_PATH_INVALID', cause });
  }
}

export function createTransportPaths(baseUrl: string): TransportPaths {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    baseUrl: normalized,
    statusUrl: buildUrl(normalized, '/status'),
    controlPlaneUrl: buildUrl(normalized, '/api/control-plane'),
    controlPlaneAuthUrl: buildUrl(normalized, '/api/control-plane/auth'),
    controlPlaneEventsUrl: buildUrl(normalized, '/api/control-plane/events'),
    controlPlaneMethodsUrl: buildUrl(normalized, '/api/control-plane/methods'),
    sessionsUrl: buildUrl(normalized, '/api/sessions'),
    tasksUrl: buildUrl(normalized, '/api/tasks'),
    approvalsUrl: buildUrl(normalized, '/api/approvals'),
    providersUrl: buildUrl(normalized, '/api/providers'),
    accountsUrl: buildUrl(normalized, '/api/accounts'),
    localAuthUrl: buildUrl(normalized, '/api/local-auth'),
    telemetryUrl: buildUrl(normalized, '/api/v1/telemetry'),
    telemetryEventsUrl: buildUrl(normalized, '/api/v1/telemetry/events'),
    telemetryErrorsUrl: buildUrl(normalized, '/api/v1/telemetry/errors'),
    telemetryTracesUrl: buildUrl(normalized, '/api/v1/telemetry/traces'),
    telemetryMetricsUrl: buildUrl(normalized, '/api/v1/telemetry/metrics'),
    telemetryStreamUrl: buildUrl(normalized, '/api/v1/telemetry/stream'),
    telemetryOtlpTracesUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/traces'),
    telemetryOtlpLogsUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/logs'),
    telemetryOtlpMetricsUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/metrics'),
    remoteUrl: buildUrl(normalized, '/api/remote'),
    remoteContractUrl: buildUrl(normalized, '/api/remote/node-host/contract'),
    peerRequestsUrl: buildUrl(normalized, '/api/remote/pair/requests'),
    peerListUrl: buildUrl(normalized, '/api/remote/peers'),
    remoteWorkUrl: buildUrl(normalized, '/api/remote/work'),
    controlUrl: buildUrl(normalized, '/api/control-plane'),
  };
}
