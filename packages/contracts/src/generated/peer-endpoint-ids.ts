export const PEER_ENDPOINT_IDS = [
  "operator.snapshot",
  "pair.request",
  "pair.verify",
  "peer.heartbeat",
  "work.complete",
  "work.pull",
] as const;
export type PeerEndpointId = typeof PEER_ENDPOINT_IDS[number];
