import { fileURLToPath } from 'node:url';

export function getOperatorContractPath(): string {
  return fileURLToPath(new URL('../artifacts/operator-contract.json', import.meta.url));
}

export function getPeerContractPath(): string {
  return fileURLToPath(new URL('../artifacts/peer-contract.json', import.meta.url));
}
