import {
  createFetch,
  createHttpTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJsonRaw,
  type HttpJsonRequestOptions,
  type HttpRetryPolicy,
  type HttpTransport,
  type HttpTransportOptions,
  type JsonObject,
  type JsonValue,
  type ResolvedContractRequest,
  type TransportJsonError,
} from '@pellux/goodvibes-transport-http';

export type {
  HttpJsonRequestOptions,
  HttpRetryPolicy,
  JsonObject,
  JsonValue,
  ResolvedContractRequest,
  TransportJsonError,
};

export {
  createFetch,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJsonRaw,
};

export type HttpJsonTransportOptions = HttpTransportOptions;
export type HttpJsonTransport = HttpTransport;

export function createHttpJsonTransport(options: HttpJsonTransportOptions): HttpJsonTransport {
  return createHttpTransport(options);
}
