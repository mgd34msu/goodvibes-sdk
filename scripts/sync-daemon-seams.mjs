import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTuiRoot } from './source-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TUI_ROOT = resolveTuiRoot({ required: true });
const CHECK_ONLY = process.argv.includes('--check');

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function syncFile(target, content) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    throw new Error(`daemon seam is out of sync: ${target}`);
  }
  ensureDir(target);
  writeFileSync(target, content);
  return true;
}

function loadSource(path) {
  return readFileSync(resolve(TUI_ROOT, path), 'utf8');
}

function withHeader(content, sourcePath) {
  return `// Synced from goodvibes-tui/${sourcePath}\n${content}`;
}

const specs = [
  ['src/control-plane/routes/context.ts', 'packages/daemon-sdk/src/context.ts', (content) => content],
  ['src/control-plane/routes/api-router.ts', 'packages/daemon-sdk/src/api-router.ts', (content) => content
    .replaceAll("'./automation.ts'", "'./automation.js'")
    .replaceAll("'./operator.ts'", "'./operator.js'")
    .replaceAll("'./remote.ts'", "'./remote.js'")
    .replaceAll("'./sessions.ts'", "'./sessions.js'")
    .replaceAll("'./tasks.ts'", "'./tasks.js'")
    .replaceAll("'./context.ts'", "'./context.js'")],
  ['src/control-plane/routes/automation.ts', 'packages/daemon-sdk/src/automation.ts', (content) => content.replaceAll("'./context.ts'", "'./context.js'")],
  ['src/control-plane/routes/operator.ts', 'packages/daemon-sdk/src/operator.ts', (content) => content.replaceAll("'./context.ts'", "'./context.js'")],
  ['src/control-plane/routes/remote.ts', 'packages/daemon-sdk/src/remote.ts', (content) => content.replaceAll("'./context.ts'", "'./context.js'")],
  ['src/control-plane/routes/sessions.ts', 'packages/daemon-sdk/src/sessions.ts', (content) => content.replaceAll("'./context.ts'", "'./context.js'")],
  ['src/control-plane/routes/tasks.ts', 'packages/daemon-sdk/src/tasks.ts', (content) => content.replaceAll("'./context.ts'", "'./context.js'")],
  ['src/daemon/http/route-helpers.ts', 'packages/daemon-sdk/src/route-helpers.ts', (content) => content],
  ['src/daemon/http-policy.ts', 'packages/daemon-sdk/src/http-policy.ts', (content) => content.replaceAll("'./http/route-helpers.ts'", "'./route-helpers.js'")],
  ['src/daemon/http/channel-route-types.ts', 'packages/daemon-sdk/src/channel-route-types.ts', (content) => content.replaceAll("'./route-helpers.ts'", "'./route-helpers.js'")],
  ['src/daemon/http/integration-route-types.ts', 'packages/daemon-sdk/src/integration-route-types.ts', (content) => content.replaceAll("'./route-helpers.ts'", "'./route-helpers.js'")],
  ['src/daemon/http/system-route-types.ts', 'packages/daemon-sdk/src/system-route-types.ts', (content) => content.replaceAll("'./route-helpers.ts'", "'./route-helpers.js'")],
  ['src/daemon/http/knowledge-route-types.ts', 'packages/daemon-sdk/src/knowledge-route-types.ts', (content) => content],
  ['src/daemon/http/media-route-types.ts', 'packages/daemon-sdk/src/media-route-types.ts', (content) => content],
  ['src/daemon/http/control-routes.ts', 'packages/daemon-sdk/src/control-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'../../types/foundation-contract.ts'", "'@goodvibes/contracts'")
    .replaceAll("'../http-policy.ts'", "'./http-policy.js'")],
  ['src/daemon/http/telemetry-routes.ts', 'packages/daemon-sdk/src/telemetry-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'../../types/foundation-contract.ts'", "'@goodvibes/contracts'")
    .replaceAll("'../http-policy.ts'", "'./http-policy.js'")],
  ['src/daemon/http/runtime-route-types.ts', 'packages/daemon-sdk/src/runtime-route-types.ts', (content) => content.replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")],
  ['src/daemon/http/runtime-automation-routes.ts', 'packages/daemon-sdk/src/runtime-automation-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./runtime-route-types.ts'", "'./runtime-route-types.js'")
    .replaceAll("'./error-response.ts'", "'./error-response.js'")],
  ['src/daemon/http/runtime-session-routes.ts', 'packages/daemon-sdk/src/runtime-session-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./runtime-route-types.ts'", "'./runtime-route-types.js'")],
  ['src/daemon/http/runtime-routes.ts', 'packages/daemon-sdk/src/runtime-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./runtime-automation-routes.ts'", "'./runtime-automation-routes.js'")
    .replaceAll("'./runtime-session-routes.ts'", "'./runtime-session-routes.js'")
    .replaceAll("'./runtime-route-types.ts'", "'./runtime-route-types.js'")],
  ['src/daemon/http/remote-routes.ts', 'packages/daemon-sdk/src/remote-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./error-response.ts'", "'./error-response.js'")],
  ['src/daemon/http/channel-routes.ts', 'packages/daemon-sdk/src/channel-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./route-helpers.ts'", "'./route-helpers.js'")
    .replaceAll("'./channel-route-types.ts'", "'./channel-route-types.js'")],
  ['src/daemon/http/integration-routes.ts', 'packages/daemon-sdk/src/integration-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./error-response.ts'", "'./error-response.js'")
    .replaceAll("'./integration-route-types.ts'", "'./integration-route-types.js'")],
  ['src/daemon/http/system-routes.ts', 'packages/daemon-sdk/src/system-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'./route-helpers.ts'", "'./route-helpers.js'")
    .replaceAll("'./error-response.ts'", "'./error-response.js'")
    .replaceAll("'./system-route-types.ts'", "'./system-route-types.js'")],
  ['src/daemon/http/knowledge-routes.ts', 'packages/daemon-sdk/src/knowledge-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'../http-policy.ts'", "'./http-policy.js'")
    .replaceAll("'./error-response.ts'", "'./error-response.js'")
    .replaceAll("'./knowledge-route-types.ts'", "'./knowledge-route-types.js'")],
  ['src/daemon/http/media-routes.ts', 'packages/daemon-sdk/src/media-routes.ts', (content) => content
    .replaceAll("'../../control-plane/routes/context.ts'", "'./context.js'")
    .replaceAll("'../http-policy.ts'", "'./http-policy.js'")
    .replaceAll("'./error-response.ts'", "'./error-response.js'")
    .replaceAll("'./media-route-types.ts'", "'./media-route-types.js'")],
];

let changed = false;
for (const [source, target, transform] of specs) {
  const content = withHeader(transform(loadSource(source)), source);
  changed = syncFile(resolve(SDK_ROOT, target), content) || changed;
}

if (CHECK_ONLY) {
  console.log('daemon seams are in sync');
} else if (changed) {
  console.log('daemon seams synced from goodvibes-tui');
} else {
  console.log('daemon seams already up to date');
}
