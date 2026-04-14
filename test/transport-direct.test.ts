import { describe, expect, test } from 'bun:test';
import { createDirectClientTransport } from '../packages/transport-direct/dist/index.js';

describe('transport direct', () => {
  test('creates a direct client transport shell', () => {
    const operator = { kind: 'operator' };
    const peer = { kind: 'peer' };

    const transport = createDirectClientTransport(operator, peer);

    expect(transport.kind).toBe('direct');
    expect(transport.operator).toBe(operator);
    expect(transport.peer).toBe(peer);
    expect(transport.getOperatorClient()).toBe(operator);
    expect(transport.getPeerClient()).toBe(peer);
  });
});
