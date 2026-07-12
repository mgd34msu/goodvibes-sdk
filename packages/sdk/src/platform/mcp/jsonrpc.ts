/**
 * JSON-RPC 2.0 message shapes and guards shared by the MCP client's
 * stdio and HTTP transports.
 */
import { isRecord } from '../utils/record-coerce.js';

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown | undefined;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown | undefined;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown | undefined;
  error?: { code: number; message: string; data?: unknown };
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

export function jsonRpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value)
    && 'id' in value
    && (isJsonRpcId(value.id) || value.id === null)
    && typeof value.method !== 'string';
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value)
    && typeof value.method === 'string'
    && isJsonRpcId(value.id);
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value)
    && typeof value.method === 'string'
    && (!('id' in value) || value.id === null);
}
