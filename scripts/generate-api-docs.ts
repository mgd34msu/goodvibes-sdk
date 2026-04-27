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
  lines.push('Generated from the synced GoodVibes operator contract artifact.');
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
  lines.push('Generated from the synced GoodVibes peer contract artifact.');
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
  lines.push('Generated from the synced GoodVibes operator event contract artifact.');
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
  // Append handwritten named-events section for the `workflows` domain.
  // These events are not in the contract artifact schema but are emitted by the
  // WRFC controller and must be documented alongside the generated domain schemas.
  lines.push('## Named WRFC workflow events');
  lines.push('');
  lines.push('The following named events are emitted on the `workflows` domain by the WRFC controller. They are not currently in the operator contract artifact — they are documented here as the authoritative reference.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### `WORKFLOW_CONSTRAINTS_ENUMERATED`');
  lines.push('');
  lines.push('Emitted exactly once per WRFC chain immediately after the initial engineer agent completes and the controller has captured the constraint list from the engineer\'s report. Fixer re-runs do not re-emit this event.');
  lines.push('');
  lines.push('| Field | Type | Description |');
  lines.push('|-------|------|-------------|');
  lines.push('| `chainId` | `string` | The WRFC chain that produced the constraints |');
  lines.push('| `constraints` | `Constraint[]` | List of user-declared constraints extracted from the task prompt. Empty array when the task was non-build or unconstrained. |');
  lines.push('');
  lines.push('`Constraint` shape:');
  lines.push('');
  lines.push('```ts');
  lines.push('interface Constraint {');
  lines.push('  id: string;                      // "c1", "c2", …');
  lines.push('  text: string;                    // quoted/near-quoted user phrasing');
  lines.push('  source: \'prompt\' | \'inherited\'; // \'prompt\' = engineer enumerated from this prompt');
  lines.push('                                   // \'inherited\' = from parent chain / gate-retry');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('**Trigger:** `WrfcController.handleEngineerCompletion` — fires when `!chain.constraintsEnumerated` (guards against duplicate emission on fixer re-runs).');
  lines.push('');
  lines.push('**Semantics:** Signals the authoritative constraint list for the chain. An empty `constraints` array signals the zero-constraint (unconstrained) path — no constraint enforcement follows.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### `WORKFLOW_REVIEW_COMPLETED`');
  lines.push('');
  lines.push('Emitted at the end of each reviewer cycle.');
  lines.push('');
  lines.push('| Field | Type | Description |');
  lines.push('|-------|------|-------------|');
  lines.push('| `chainId` | `string` | The WRFC chain |');
  lines.push('| `score` | `number` | Reviewer rubric score (0–10) |');
  lines.push('| `passed` | `boolean` | `true` when `score >= threshold && !constraintFailure` |');
  lines.push('| `constraintsSatisfied` | `number \\| undefined` | Count of satisfied constraint findings. Present only when `chain.constraints.length > 0`. |');
  lines.push('| `constraintsTotal` | `number \\| undefined` | Total constraint findings evaluated. Present only when `chain.constraints.length > 0`. |');
  lines.push('| `unsatisfiedConstraintIds` | `string[] \\| undefined` | IDs of constraints that were not satisfied. Present only when `chain.constraints.length > 0`. |');
  lines.push('');
  lines.push('When the chain has no constraints, `constraintsSatisfied`, `constraintsTotal`, and `unsatisfiedConstraintIds` are absent entirely.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### `WORKFLOW_FIX_ATTEMPTED`');
  lines.push('');
  lines.push('Emitted at the start of each fixer cycle.');
  lines.push('');
  lines.push('| Field | Type | Description |');
  lines.push('|-------|------|-------------|');
  lines.push('| `chainId` | `string` | The WRFC chain |');
  lines.push('| `attempt` | `number` | Current fix attempt number (1-indexed) |');
  lines.push('| `maxAttempts` | `number` | Maximum fix attempts configured for the chain |');
  lines.push('| `targetConstraintIds` | `string[] \\| undefined` | IDs of unsatisfied constraints this fix iteration is addressing. Present only when `chain.constraints.length > 0`. |');
  lines.push('');
  lines.push('When the chain has no constraints, `targetConstraintIds` is absent.');
  lines.push('');
  lines.push('For the full constraint propagation lifecycle, see [WRFC Constraint Propagation](./wrfc-constraint-propagation.md).');
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
