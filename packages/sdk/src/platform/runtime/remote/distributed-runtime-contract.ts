import { getPeerContract, type PeerContractManifest } from '../../../contracts.js';

export function getDistributedNodeHostContract(): PeerContractManifest {
  return getPeerContract();
}
