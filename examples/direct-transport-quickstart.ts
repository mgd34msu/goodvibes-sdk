/**
 * Use the direct in-process transport for embedded operator/peer clients.
 */
import { createDirectClientTransport } from '@pellux/goodvibes-sdk/transport-direct';

const operator = {
  async status() {
    return { ok: true };
  },
};

const peer = {
  async heartbeat() {
    return { ok: true };
  },
};

const transport = createDirectClientTransport(operator, peer);

console.log(await transport.operator.status());
console.log(await transport.peer.heartbeat());
