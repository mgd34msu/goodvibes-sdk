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

    expect(FOUNDATION_METADATA.productVersion).toBe(operator.product.version);
    expect(FOUNDATION_METADATA.operatorMethodCount).toBe(operator.operator.methods.length);
    expect(FOUNDATION_METADATA.operatorEventCount).toBe(operator.operator.events.length);
    expect(FOUNDATION_METADATA.peerEndpointCount).toBe(peer.endpoints.length);
  });

  test('generated ids stay aligned with artifact contents', () => {
    const operator = getOperatorContract();
    const peer = getPeerContract();

    expect(OPERATOR_METHOD_IDS.length).toBe(operator.operator.methods.length);
    expect(PEER_ENDPOINT_IDS.length).toBe(peer.endpoints.length);
  });

  test('runtime event domains expose the canonical vocabulary', () => {
    expect(RUNTIME_EVENT_DOMAINS).toContain('agents');
    expect(RUNTIME_EVENT_DOMAINS).toContain('control-plane');
    expect(isRuntimeEventDomain('knowledge')).toBe(true);
    expect(isRuntimeEventDomain('ready')).toBe(false);
  });
});
