import { describe, expect, test } from 'bun:test';
import {
  createBrowserGoodVibesSdk,
  createExpoGoodVibesSdk,
  createGoodVibesSdk,
  createNodeGoodVibesSdk,
  createReactNativeGoodVibesSdk,
  createWebGoodVibesSdk,
} from '../packages/sdk/dist/index.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

const fetchStub = async () => createJsonResponse({ ok: true });

describe('sdk platform integrations', () => {
  test('creates a generic composed sdk surface', () => {
    const sdk = createGoodVibesSdk({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'token-123',
      fetch: fetchStub as typeof fetch,
    });

    expect(sdk.operator.transport.baseUrl).toBe('http://127.0.0.1:3210');
    expect(sdk.peer.transport.baseUrl).toBe('http://127.0.0.1:3210');
    expect(typeof sdk.realtime.viaSse).toBe('function');
    expect(typeof sdk.realtime.viaWebSocket).toBe('function');
  });

  test('browser entry defaults baseUrl from location.origin', () => {
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://goodvibes.example.com' },
    });

    const sdk = createBrowserGoodVibesSdk({
      fetch: fetchStub as typeof fetch,
    });

    expect(sdk.operator.transport.baseUrl).toBe('https://goodvibes.example.com');

    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: previousLocation,
    });
  });

  test('web entry aliases the browser integration layer', () => {
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://goodvibes.example.com' },
    });

    const sdk = createWebGoodVibesSdk({
      fetch: fetchStub as typeof fetch,
    });

    expect(sdk.operator.transport.baseUrl).toBe('https://goodvibes.example.com');

    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: previousLocation,
    });
  });

  test('node entry aliases the generic composed sdk', () => {
    const sdk = createNodeGoodVibesSdk({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: fetchStub as typeof fetch,
    });

    expect(typeof sdk.operator.control.snapshot).toBe('function');
    expect(typeof sdk.realtime.viaSse).toBe('function');
  });

  test('react native entry exposes websocket-first realtime helpers', () => {
    class FakeWebSocket {}

    const sdk = createReactNativeGoodVibesSdk({
      baseUrl: 'https://goodvibes.example.com',
      authToken: 'token-123',
      fetch: fetchStub as typeof fetch,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(typeof sdk.realtime.runtime).toBe('function');
    expect(typeof sdk.realtime.viaWebSocket).toBe('function');
    expect(sdk.realtime.runtime().domains).toContain('agents');
  });

  test('expo entry aliases the react native integration layer', () => {
    class FakeWebSocket {}

    const sdk = createExpoGoodVibesSdk({
      baseUrl: 'https://goodvibes.example.com',
      authToken: 'token-123',
      fetch: fetchStub as typeof fetch,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(typeof sdk.realtime.runtime).toBe('function');
    expect(sdk.realtime.runtime().domains).toContain('agents');
  });
});
