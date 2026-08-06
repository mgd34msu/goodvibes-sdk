import { assertSameOriginAbsoluteUrl } from './paths.js';
import { openRawServerSentEventStream, type ServerSentEventHandlers, type ServerSentEventStreamHandle, type ServerSentEventOptions as CoreServerSentEventOptions } from './sse-stream.js';
import type { HttpTransport } from './http.js';

export type { ServerSentEventHandlers, ServerSentEventStreamHandle };
export interface ServerSentEventOptions extends Omit<CoreServerSentEventOptions, 'authToken'> {}

export async function openServerSentEventStream(
  transport: HttpTransport,
  pathOrUrl: string,
  handlers: ServerSentEventHandlers,
  options: ServerSentEventOptions = {},
): Promise<ServerSentEventStreamHandle> {
  const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
    ? assertSameOriginAbsoluteUrl(pathOrUrl, transport.buildUrl('/'))
    : transport.buildUrl(pathOrUrl);
  return await openRawServerSentEventStream(transport.fetchImpl, url, handlers, {
    ...options,
    authToken: transport.authToken,
    getAuthToken: transport.getAuthToken.bind(transport),
  });
}
