import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const operatorContract = JSON.parse(
  readFileSync(resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json'), 'utf8'),
);
const peerContract = JSON.parse(
  readFileSync(resolve(SDK_ROOT, 'packages/contracts/artifacts/peer-contract.json'), 'utf8'),
);

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function writeIfChanged(path, content) {
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    throw new Error(`generated docs are out of sync: ${path}`);
  }
  ensureDir(path);
  writeFileSync(path, content);
  return true;
}

function stringify(value) {
  return `\`${String(value)}\``;
}

function codeFence(value, language = 'json') {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function list(items) {
  if (!items || items.length === 0) return 'none';
  return items.map((item) => `\`${item}\``).join(', ');
}

function schemaBlock(schema) {
  if (!schema) return 'none';
  return codeFence(JSON.stringify(schema, null, 2));
}

function byKey(items, key) {
  const grouped = new Map();
  for (const item of items) {
    const group = item[key] ?? 'uncategorized';
    const existing = grouped.get(group) ?? [];
    existing.push(item);
    grouped.set(group, existing);
  }
  return Array.from(grouped.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function renderOperatorReference() {
  const lines = [];
  lines.push('# Operator API Reference');
  lines.push('');
  lines.push(`Generated from the synced GoodVibes operator contract for product version \`${operatorContract.product.version}\`.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Methods: \`${operatorContract.operator.methods.length}\``);
  lines.push(`- Events: \`${operatorContract.operator.events.length}\``);
  lines.push(`- Auth modes: ${list(operatorContract.auth.modes)}`);
  lines.push(`- HTTP status path: ${stringify(operatorContract.transports.http.statusPath)}`);
  lines.push(`- Methods catalog path: ${stringify(operatorContract.transports.http.methodsPath)}`);
  lines.push(`- Event catalog path: ${stringify(operatorContract.transports.http.eventsCatalogPath)}`);
  lines.push(`- SSE path: ${stringify(operatorContract.transports.sse.path)}`);
  lines.push(`- WebSocket path: ${stringify(operatorContract.transports.websocket.path)}`);
  lines.push('');
  lines.push('Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.');
  lines.push('');
  lines.push('## Authentication');
  lines.push('');
  lines.push(`- Login route: ${stringify(`${operatorContract.auth.login.method} ${operatorContract.auth.login.path}`)}`);
  lines.push(`- Current-auth route: ${stringify(`${operatorContract.auth.current.method} ${operatorContract.auth.current.path}`)}`);
  lines.push(`- Current-auth aliases: ${list(operatorContract.auth.current.aliasPaths)}`);
  lines.push(`- Session cookie: ${stringify(operatorContract.auth.sessionCookie.name)} (${operatorContract.auth.sessionCookie.sameSite}, path ${operatorContract.auth.sessionCookie.path})`);
  lines.push(`- Bearer header: ${stringify(operatorContract.auth.bearer.header)}`);
  lines.push('');
  lines.push('## Realtime transports');
  lines.push('');
  lines.push('### WebSocket client frames');
  lines.push('');
  for (const frame of operatorContract.transports.websocket.clientFrames) {
    lines.push(`- ${stringify(frame.type)}${frame.fields?.length ? `: ${list(frame.fields)}` : ''}`);
  }
  lines.push('');
  lines.push('### WebSocket server frames');
  lines.push('');
  for (const frame of operatorContract.transports.websocket.serverFrames) {
    lines.push(`- ${stringify(frame.type)}${frame.fields?.length ? `: ${list(frame.fields)}` : ''}`);
  }
  lines.push('');
  lines.push('## Methods');
  lines.push('');
  for (const [category, methods] of byKey(operatorContract.operator.methods, 'category')) {
    lines.push(`### ${category}`);
    lines.push('');
    for (const method of methods.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`#### ${stringify(method.id)}`);
      lines.push('');
      lines.push(method.description);
      lines.push('');
      lines.push(`- Title: ${stringify(method.title)}`);
      lines.push(`- Source: ${stringify(method.source)}`);
      lines.push(`- Access: ${stringify(method.access)}`);
      lines.push(`- Transport: ${list(method.transport)}`);
      lines.push(`- HTTP: ${method.http ? stringify(`${method.http.method} ${method.http.path}`) : 'none'}`);
      lines.push(`- Scopes: ${list(method.scopes)}`);
      lines.push(`- Emits events: ${list(method.events ?? [])}`);
      lines.push(`- Dangerous: ${method.dangerous ? '`yes`' : '`no`'}`);
      lines.push(`- Invokable: ${method.invokable === false ? '`no`' : '`yes`'}`);
      lines.push('');
      lines.push('##### Input schema');
      lines.push('');
      lines.push(schemaBlock(method.inputSchema));
      lines.push('');
      lines.push('##### Output schema');
      lines.push('');
      lines.push(schemaBlock(method.outputSchema));
      lines.push('');
    }
  }
  lines.push('## Events');
  lines.push('');
  for (const [category, events] of byKey(operatorContract.operator.events, 'category')) {
    lines.push(`### ${category}`);
    lines.push('');
    for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`#### ${stringify(event.id)}`);
      lines.push('');
      lines.push(event.description);
      lines.push('');
      lines.push(`- Title: ${stringify(event.title)}`);
      lines.push(`- Source: ${stringify(event.source)}`);
      lines.push(`- Transport: ${list(event.transport)}`);
      lines.push(`- Scopes: ${list(event.scopes)}`);
      lines.push(`- Domains: ${list(event.domains ?? [])}`);
      lines.push(`- Wire events: ${list(event.wireEvents ?? [])}`);
      lines.push('');
      lines.push('##### Payload schema');
      lines.push('');
      lines.push(schemaBlock(event.outputSchema));
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderPeerReference() {
  const lines = [];
  lines.push('# Peer API Reference');
  lines.push('');
  lines.push(`Generated from the synced GoodVibes peer contract for product version \`${operatorContract.product.version}\`.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Schema version: \`${peerContract.schemaVersion}\``);
  lines.push(`- Transport: ${stringify(peerContract.transport)}`);
  lines.push(`- Base path: ${stringify(peerContract.basePath)}`);
  lines.push(`- Peer kinds: ${list(peerContract.peerKinds)}`);
  lines.push(`- Work types: ${list(peerContract.workTypes)}`);
  lines.push(`- Work completion statuses: ${list(peerContract.workCompletionStatuses)}`);
  lines.push(`- Peer scopes: ${list(peerContract.scopes)}`);
  lines.push(`- Recommended heartbeat ms: \`${peerContract.recommendedHeartbeatMs}\``);
  lines.push(`- Recommended work-pull ms: \`${peerContract.recommendedWorkPullMs}\``);
  lines.push('');
  lines.push('Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.');
  lines.push('');
  lines.push('## Endpoints');
  lines.push('');
  for (const endpoint of [...peerContract.endpoints].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`### ${stringify(endpoint.id)}`);
    lines.push('');
    lines.push(endpoint.description);
    lines.push('');
    lines.push(`- HTTP: ${stringify(`${endpoint.method} ${endpoint.path}`)}`);
    lines.push(`- Auth: ${stringify(endpoint.auth)}`);
    lines.push(`- Required scope: ${endpoint.requiredScope ? stringify(endpoint.requiredScope) : 'none'}`);
    lines.push('');
    lines.push('#### Input schema');
    lines.push('');
    lines.push(schemaBlock(endpoint.inputSchema));
    lines.push('');
    lines.push('#### Output schema');
    lines.push('');
    lines.push(schemaBlock(endpoint.outputSchema));
    lines.push('');
  }
  lines.push('## Contract metadata');
  lines.push('');
  lines.push(peerContract.metadata?.note ?? 'none');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderRuntimeEventReference() {
  const lines = [];
  const domains = new Map();
  for (const event of operatorContract.operator.events) {
    for (const domain of event.domains ?? []) {
      const existing = domains.get(domain) ?? [];
      existing.push(event);
      domains.set(domain, existing);
    }
  }

  lines.push('# Runtime Events Reference');
  lines.push('');
  lines.push(`Generated from the synced GoodVibes operator event contract for product version \`${operatorContract.product.version}\`.`);
  lines.push('');
  lines.push('## Transport endpoints');
  lines.push('');
  lines.push(`- SSE: ${stringify(operatorContract.transports.sse.path)}`);
  lines.push(`- WebSocket: ${stringify(operatorContract.transports.websocket.path)}`);
  lines.push(`- SSE query: ${stringify(`domains=${operatorContract.transports.sse.query.domains}`)}`);
  lines.push('');
  lines.push('Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.');
  lines.push('');
  lines.push('## Runtime domains');
  lines.push('');
  for (const [domain, events] of Array.from(domains.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${stringify(domain)}`);
    lines.push('');
    for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${stringify(event.id)}${event.wireEvents?.length ? ` -> ${list(event.wireEvents)}` : ''}`);
    }
    lines.push('');
    for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`#### ${stringify(event.id)} payload schema`);
      lines.push('');
      lines.push(schemaBlock(event.outputSchema));
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

let changed = false;
changed = writeIfChanged(resolve(SDK_ROOT, 'docs/reference-operator.md'), renderOperatorReference()) || changed;
changed = writeIfChanged(resolve(SDK_ROOT, 'docs/reference-peer.md'), renderPeerReference()) || changed;
changed = writeIfChanged(resolve(SDK_ROOT, 'docs/reference-runtime-events.md'), renderRuntimeEventReference()) || changed;

if (CHECK_ONLY) {
  console.log('generated API docs are in sync');
} else if (changed) {
  console.log('generated API docs updated');
} else {
  console.log('generated API docs already up to date');
}
