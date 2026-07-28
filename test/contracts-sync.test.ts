import { describe, expect, test } from 'bun:test';
import {
  FOUNDATION_METADATA,
  getOperatorContract,
  getPeerContract,
  isRuntimeEventDomain,
  OPERATOR_METHOD_IDS,
  PEER_ENDPOINT_IDS,
  RUNTIME_EVENT_DOMAINS,
} from '../packages/contracts/dist/index.js';

describe('contracts package', () => {
  test('foundation metadata matches synced artifacts', () => {
    const operator = getOperatorContract();
    const peer = getPeerContract();

    expect(FOUNDATION_METADATA.productVersion as string).toBe(operator.product.version);
    expect(FOUNDATION_METADATA.operatorMethodCount as number).toBe(operator.operator.methods.length);
    expect(FOUNDATION_METADATA.operatorEventCount as number).toBe(operator.operator.events.length);
    expect(FOUNDATION_METADATA.peerEndpointCount as number).toBe(peer.endpoints.length);
  });

  test('generated ids stay aligned with artifact contents', () => {
    const operator = getOperatorContract();
    const peer = getPeerContract();

    expect(OPERATOR_METHOD_IDS.length as number).toBe(operator.operator.methods.length);
    expect(PEER_ENDPOINT_IDS.length as number).toBe(peer.endpoints.length);
  });

  test('runtime event domains expose the canonical vocabulary', () => {
    expect(RUNTIME_EVENT_DOMAINS).toContain('agents');
    expect(RUNTIME_EVENT_DOMAINS).toContain('control-plane');
    expect(isRuntimeEventDomain('knowledge')).toBe(true);
    expect(isRuntimeEventDomain('ready')).toBe(false);
  });
});
