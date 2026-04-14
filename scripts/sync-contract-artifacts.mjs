import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TUI_ROOT = '/home/buzzkill/Projects/goodvibes-tui';

const CHECK_ONLY = process.argv.includes('--check');

const ARTIFACT_SPECS = [
  {
    name: 'operator-contract',
    source: resolve(TUI_ROOT, 'docs/foundation-artifacts/operator-contract.json'),
    target: resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json'),
  },
  {
    name: 'peer-contract',
    source: resolve(TUI_ROOT, 'docs/foundation-artifacts/peer-contract.json'),
    target: resolve(SDK_ROOT, 'packages/contracts/artifacts/peer-contract.json'),
  },
];

const TYPES_SOURCE = resolve(TUI_ROOT, 'src/types/foundation-contract.ts');
const TYPES_TARGET = resolve(SDK_ROOT, 'packages/contracts/src/types.ts');
const FOUNDATION_CLIENT_TYPES_SOURCE = resolve(TUI_ROOT, 'src/types/generated/foundation-client-types.ts');
const FOUNDATION_CLIENT_TYPES_TARGET = resolve(SDK_ROOT, 'packages/contracts/src/generated/foundation-client-types.ts');

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function writeFile(path, content) {
  ensureDir(path);
  writeFileSync(path, content);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function syncArtifact(spec) {
  const source = readFileSync(spec.source, 'utf8');
  let current = null;
  try {
    current = readFileSync(spec.target, 'utf8');
  } catch {
    current = null;
  }
  if (current === source) return false;
  if (CHECK_ONLY) {
    throw new Error(`${spec.name} is out of sync: ${spec.target}`);
  }
  writeFile(spec.target, source);
  return true;
}

function renderStringArray(name, values) {
  const body = values.map((value) => `  ${JSON.stringify(value)},`).join('\n');
  return `export const ${name} = [\n${body}\n] as const;\n`;
}

function generateOperatorMethodIds(operatorContract) {
  const ids = operatorContract.operator.methods.map((method) => method.id).sort();
  return `${renderStringArray('OPERATOR_METHOD_IDS', ids)}export type OperatorMethodId = typeof OPERATOR_METHOD_IDS[number];\n`;
}

function generatePeerEndpointIds(peerContract) {
  const ids = peerContract.endpoints.map((endpoint) => endpoint.id).sort();
  return `${renderStringArray('PEER_ENDPOINT_IDS', ids)}export type PeerEndpointId = typeof PEER_ENDPOINT_IDS[number];\n`;
}

function generateFoundationMetadata(operatorContract, peerContract) {
  const payload = {
    productId: operatorContract.product.id,
    productVersion: operatorContract.product.version,
    operatorMethodCount: operatorContract.operator.methods.length,
    operatorEventCount: operatorContract.operator.events.length,
    peerEndpointCount: peerContract.endpoints.length,
  };
  return `export const FOUNDATION_METADATA = ${JSON.stringify(payload, null, 2)} as const;\n`;
}

function parseRuntimeEventDomains(source) {
  const match = source.match(/export const RUNTIME_EVENT_DOMAINS = \[([\s\S]*?)\] as const;/);
  if (!match) {
    throw new Error('Unable to parse RUNTIME_EVENT_DOMAINS from goodvibes-tui');
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g), (entry) => entry[1]);
}

function generateRuntimeEventDomains(runtimeDomains) {
  return `${renderStringArray('RUNTIME_EVENT_DOMAINS', runtimeDomains)}export type RuntimeEventDomain = typeof RUNTIME_EVENT_DOMAINS[number];\n\nexport function isRuntimeEventDomain(value: string): value is RuntimeEventDomain {\n  return (RUNTIME_EVENT_DOMAINS as readonly string[]).includes(value);\n}\n`;
}

function generateEmbeddedOperatorContract(operatorContract) {
  return `import type { OperatorContractManifest } from '../types.js';\n\nexport const OPERATOR_CONTRACT: OperatorContractManifest = ${JSON.stringify(operatorContract, null, 2)};\n`;
}

function generateEmbeddedPeerContract(peerContract) {
  return `import type { PeerContractManifest } from '../types.js';\n\nexport const PEER_CONTRACT: PeerContractManifest = ${JSON.stringify(peerContract, null, 2)};\n`;
}

function syncGeneratedFile(path, content) {
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    throw new Error(`generated file is out of sync: ${path}`);
  }
  writeFile(path, content);
  return true;
}

let changed = false;
for (const spec of ARTIFACT_SPECS) {
  changed = syncArtifact(spec) || changed;
}

const contractTypes = readFileSync(TYPES_SOURCE, 'utf8');
changed = syncGeneratedFile(TYPES_TARGET, contractTypes) || changed;

const foundationClientTypes = readFileSync(FOUNDATION_CLIENT_TYPES_SOURCE, 'utf8');
changed = syncGeneratedFile(FOUNDATION_CLIENT_TYPES_TARGET, foundationClientTypes) || changed;

const operatorContract = readJson(resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json'));
const peerContract = readJson(resolve(SDK_ROOT, 'packages/contracts/artifacts/peer-contract.json'));
const runtimeDomainSource = readFileSync(resolve(TUI_ROOT, 'src/runtime/events/domain-map.ts'), 'utf8');
const runtimeDomains = parseRuntimeEventDomains(runtimeDomainSource);

changed = syncGeneratedFile(
  resolve(SDK_ROOT, 'packages/contracts/src/generated/operator-method-ids.ts'),
  generateOperatorMethodIds(operatorContract),
) || changed;

changed = syncGeneratedFile(
  resolve(SDK_ROOT, 'packages/contracts/src/generated/peer-endpoint-ids.ts'),
  generatePeerEndpointIds(peerContract),
) || changed;

changed = syncGeneratedFile(
  resolve(SDK_ROOT, 'packages/contracts/src/generated/foundation-metadata.ts'),
  generateFoundationMetadata(operatorContract, peerContract),
) || changed;

changed = syncGeneratedFile(
  resolve(SDK_ROOT, 'packages/contracts/src/generated/runtime-event-domains.ts'),
  generateRuntimeEventDomains(runtimeDomains),
) || changed;

changed = syncGeneratedFile(
  resolve(SDK_ROOT, 'packages/contracts/src/generated/operator-contract.ts'),
  generateEmbeddedOperatorContract(operatorContract),
) || changed;

changed = syncGeneratedFile(
  resolve(SDK_ROOT, 'packages/contracts/src/generated/peer-contract.ts'),
  generateEmbeddedPeerContract(peerContract),
) || changed;

if (CHECK_ONLY) {
  console.log('contracts are in sync');
} else if (changed) {
  console.log('contracts synced from goodvibes-tui');
} else {
  console.log('contracts already up to date');
}
