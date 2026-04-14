// Synced from packages/transport-http/src/sse.ts
import { openServerSentEventStream as openServerSentEventStreamCore, type ServerSentEventHandlers, type ServerSentEventOptions as CoreServerSentEventOptions } from './sse-stream.js';
import { type HttpTransport, normalizeTransportError } from './http.js';

export type { ServerSentEventHandlers };
export interface ServerSentEventOptions extends Omit<CoreServerSentEventOptions, 'authToken'> {}

export async function openServerSentEventStream(
  transport: HttpTransport,
  pathOrUrl: string,
  handlers: ServerSentEventHandlers,
  options: ServerSentEventOptions = {},
): Promise<() => void> {
  const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : transport.buildUrl(pathOrUrl);
  try {
    return await openServerSentEventStreamCore(transport.fetchImpl, url, handlers, {
      ...options,
      authToken: transport.authToken,
      getAuthToken: transport.getAuthToken.bind(transport),
    });
  } catch (error) {
    throw normalizeTransportError(error);
  }
}
