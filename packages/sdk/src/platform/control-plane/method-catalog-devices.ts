/**
 * method-catalog-devices.ts — paired-device verbs.
 *
 * The operator-contract surface for the paired-phone capability feature: which
 * device nodes are paired and what each can serve, ASKING one of them for a
 * capability and reading back what it returned, the durable "always allow"
 * grants with the ledger behind them, revoking a grant, and running the
 * housekeeping sweep on demand with its disclosure.
 *
 * The grants surface in any client renders from these verbs, so "visible and
 * revocable in the grants surface" (owner ruling 2026-07-25) is one contract
 * every surface shares rather than a per-surface reimplementation.
 *
 * `devices.capability.request` is what makes the feature reachable from a
 * surface that does not host the device posture runtime itself. In-process, the
 * `phone` tool calls `DeviceCapabilityService.request` directly; a client with
 * no runtime of its own had a grants surface it could read and revoke from, and
 * no way to actually ask a phone for anything. These three verbs are that path,
 * and they are deliberately the SAME path: the confirmation prompt, the durable
 * grant lookup, the capture retention and the disclosure all stay inside the
 * runtime. Nothing here re-decides any of it.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  JSON_OBJECT_SCHEMA,
  JSON_VALUE_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const DEVICE_NODE_SCHEMA = objectSchema({
  nodeId: STRING_SCHEMA,
  nodeKind: STRING_SCHEMA,
  nodeKindLabel: STRING_SCHEMA,
  label: STRING_SCHEMA,
  platform: STRING_SCHEMA,
  appVersion: STRING_SCHEMA,
  contractVersion: NUMBER_SCHEMA,
  contractCompatible: BOOLEAN_SCHEMA,
  supported: arraySchema(STRING_SCHEMA),
  undeclared: arraySchema(STRING_SCHEMA),
  gatedBySecureContext: arraySchema(STRING_SCHEMA),
  unknownDeclared: arraySchema(STRING_SCHEMA),
}, ['nodeId', 'nodeKind', 'nodeKindLabel', 'label', 'platform', 'appVersion', 'contractVersion', 'contractCompatible', 'supported', 'undeclared', 'gatedBySecureContext', 'unknownDeclared']);

const DEVICE_CAPABILITY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  family: STRING_SCHEMA,
  title: STRING_SCHEMA,
  purpose: STRING_SCHEMA,
  effect: STRING_SCHEMA,
  sensitivity: STRING_SCHEMA,
  producesArtifact: BOOLEAN_SCHEMA,
  allowAlwaysOffered: BOOLEAN_SCHEMA,
}, ['id', 'family', 'title', 'purpose', 'effect', 'sensitivity', 'producesArtifact', 'allowAlwaysOffered']);

const DEVICE_GRANT_SCHEMA = objectSchema({
  grantId: STRING_SCHEMA,
  nodeId: STRING_SCHEMA,
  nodeKind: STRING_SCHEMA,
  capabilityId: STRING_SCHEMA,
  capabilityTitle: STRING_SCHEMA,
  scope: STRING_SCHEMA,
  grantedAt: NUMBER_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  lastUsedAt: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  useCount: NUMBER_SCHEMA,
  grantedBy: STRING_SCHEMA,
}, ['grantId', 'nodeId', 'nodeKind', 'capabilityId', 'capabilityTitle', 'scope', 'grantedAt', 'expiresAt', 'lastUsedAt', 'useCount', 'grantedBy']);

const DEVICE_GRANT_AUDIT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  action: STRING_SCHEMA,
  grantId: STRING_SCHEMA,
  nodeId: STRING_SCHEMA,
  capabilityId: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  actor: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['id', 'action', 'grantId', 'nodeId', 'capabilityId', 'at', 'actor', 'reason']);

const DEVICE_REMOVAL_SCHEMA = objectSchema({
  grantId: STRING_SCHEMA,
  nodeId: STRING_SCHEMA,
  capabilityId: STRING_SCHEMA,
  scope: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  removedAt: NUMBER_SCHEMA,
}, ['grantId', 'nodeId', 'capabilityId', 'scope', 'reason', 'removedAt']);

const DEVICE_ARTIFACT_REMOVAL_SCHEMA = objectSchema({
  artifactId: STRING_SCHEMA,
  nodeId: STRING_SCHEMA,
  capabilityId: STRING_SCHEMA,
  fileName: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  removedAt: NUMBER_SCHEMA,
  byteLength: NUMBER_SCHEMA,
}, ['artifactId', 'nodeId', 'capabilityId', 'fileName', 'reason', 'removedAt', 'byteLength']);

/** A retained capture, as every device verb describes one. */
const DEVICE_ARTIFACT_SCHEMA = objectSchema({
  artifactId: STRING_SCHEMA,
  nodeId: STRING_SCHEMA,
  capabilityId: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  mediaType: STRING_SCHEMA,
  byteLength: NUMBER_SCHEMA,
  capturedAt: NUMBER_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  reason: STRING_SCHEMA,
  /** Where the bytes sit on the daemon host — usable only by a colocated caller. */
  daemonPath: STRING_SCHEMA,
}, ['artifactId', 'nodeId', 'capabilityId', 'kind', 'mediaType', 'byteLength', 'capturedAt', 'expiresAt', 'reason', 'daemonPath']);

export const builtinGatewayDeviceMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'devices.nodes.list',
    title: 'List Paired Device Nodes',
    description: 'Every phone paired as a device node, with the capabilities it announced, the ones it did not offer, and the ones it announced but cannot currently serve because its connection is not a secure context. Node-kind neutral: a web app node and a native app node are described identically.',
    category: 'runtime',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/devices/nodes' },
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      nodes: arraySchema(DEVICE_NODE_SCHEMA),
      capabilities: arraySchema(DEVICE_CAPABILITY_SCHEMA),
      mode: STRING_SCHEMA,
      allowAlwaysOffer: STRING_SCHEMA,
      captureRetentionHours: NUMBER_SCHEMA,
    }, ['nodes', 'capabilities', 'mode', 'allowAlwaysOffer', 'captureRetentionHours']),
  }),
  methodDescriptor({
    id: 'devices.capability.request',
    title: 'Request a Capability From a Paired Device',
    description: 'Ask one paired device node for one capability — a photo, a screen capture, a location fix, its clipboard, a notification, a link to open, a buzz — and return what came back. The reason is required and is shown VERBATIM on the confirmation prompt, so the person deciding sees what the caller said it was for. Every gate lives in the daemon-owned device runtime and this verb re-decides none of them: a durable grant is re-read from disk (never cached), a request with no grant asks the person on whatever surface they are looking at, a capability turned off by configuration is refused with the configuration key that turned it off, and a capture is retained under the configured retention window and disclosed. A refusal is returned as ok:false with the reason and a machine-readable refusal code — it is an answer, not an error. A capability that produces a capture returns an artifact REFERENCE; fetch the bytes with devices.artifacts.read.',
    category: 'runtime',
    scopes: ['write:remote'],
    http: { method: 'POST', path: '/api/devices/capability/request' },
    inputSchema: objectSchema({
      nodeId: STRING_SCHEMA,
      capabilityId: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      input: JSON_OBJECT_SCHEMA,
      sessionId: STRING_SCHEMA,
      timeoutMs: NUMBER_SCHEMA,
    }, ['nodeId', 'capabilityId', 'reason']),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      nodeId: STRING_SCHEMA,
      capabilityId: STRING_SCHEMA,
      capabilityTitle: STRING_SCHEMA,
      /** existing-grant | confirmed-once | confirmed-always. Empty on a refusal. */
      authority: STRING_SCHEMA,
      grantId: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
      data: JSON_VALUE_SCHEMA,
      artifact: { anyOf: [DEVICE_ARTIFACT_SCHEMA, { type: 'null' }] },
      /** node-unknown | capability-unknown | capability-unsupported | capability-gated-by-secure-context | disabled-by-config | denied-by-person | dispatch-failed. Empty when ok. */
      refusal: STRING_SCHEMA,
      detail: STRING_SCHEMA,
    }, ['ok', 'nodeId', 'capabilityId', 'capabilityTitle', 'authority', 'grantId', 'artifact', 'refusal', 'detail']),
  }),
  methodDescriptor({
    id: 'devices.artifacts.list',
    title: 'List Retained Device Captures',
    description: 'The camera and screen captures still inside their retention window, newest first, with when each was captured, when it will be deleted, and the reason the request stated. Expired captures are never listed — retention is enforced by the store, not by this verb filtering them out of a longer list.',
    category: 'runtime',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/devices/artifacts' },
    inputSchema: objectSchema({ nodeId: STRING_SCHEMA, limit: NUMBER_SCHEMA }, []),
    outputSchema: objectSchema({
      artifacts: arraySchema(DEVICE_ARTIFACT_SCHEMA),
      retained: NUMBER_SCHEMA,
      retentionHours: NUMBER_SCHEMA,
    }, ['artifacts', 'retained', 'retentionHours']),
  }),
  methodDescriptor({
    id: 'devices.artifacts.read',
    title: 'Read a Retained Device Capture',
    description: 'Return one retained capture\'s bytes, base64-encoded, for a caller that is not running on the daemon host and so cannot open the file itself. The store re-hashes the bytes against the digest recorded when the capture was retained and refuses to serve a mismatch, so a torn or half-written file is never handed back as if it were the picture that was taken. A capture that is gone — expired, swept, missing, or corrupted — is an honest 404 naming which of those it was.',
    category: 'runtime',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/devices/artifacts/{artifactId}' },
    inputSchema: objectSchema({ artifactId: STRING_SCHEMA }, ['artifactId']),
    outputSchema: objectSchema({
      artifact: DEVICE_ARTIFACT_SCHEMA,
      dataBase64: STRING_SCHEMA,
    }, ['artifact', 'dataBase64']),
  }),
  methodDescriptor({
    id: 'devices.grants.list',
    title: 'List Device Capability Grants',
    description: 'The durable "always allow" grants a person gave, per capability and per device, with when each was granted, when it expires, and how often it has been used — plus the recent ledger of grants given, used, revoked, and expired.',
    category: 'runtime',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/devices/grants' },
    inputSchema: objectSchema({ nodeId: STRING_SCHEMA, limit: NUMBER_SCHEMA }, []),
    outputSchema: objectSchema({
      grants: arraySchema(DEVICE_GRANT_SCHEMA),
      audit: arraySchema(DEVICE_GRANT_AUDIT_SCHEMA),
    }, ['grants', 'audit']),
  }),
  methodDescriptor({
    id: 'devices.grants.revoke',
    title: 'Revoke a Device Capability Grant',
    description: 'Delete durable grants by grant id, by device, by capability, or any combination. Revoked grants are removed rather than flagged, so the next request for that capability asks the person again. Returns exactly what was removed.',
    category: 'runtime',
    scopes: ['write:config'],
    http: { method: 'POST', path: '/api/devices/grants/revoke' },
    inputSchema: objectSchema({
      grantId: STRING_SCHEMA,
      nodeId: STRING_SCHEMA,
      capabilityId: STRING_SCHEMA,
      note: STRING_SCHEMA,
    }, []),
    outputSchema: objectSchema({
      revoked: NUMBER_SCHEMA,
      removals: arraySchema(DEVICE_REMOVAL_SCHEMA),
    }, ['revoked', 'removals']),
  }),
  methodDescriptor({
    id: 'devices.housekeeping.run',
    title: 'Run Device Housekeeping',
    description: 'Sweep the device grants ledger and the retained captures now: expired and orphaned grants removed, captures past their retention window deleted, torn or missing capture files reaped. Returns the itemised disclosure of everything removed and why.',
    category: 'runtime',
    scopes: ['write:config'],
    http: { method: 'POST', path: '/api/devices/housekeeping' },
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      summary: STRING_SCHEMA,
      sweptAt: NUMBER_SCHEMA,
      grantsRemoved: arraySchema(DEVICE_REMOVAL_SCHEMA),
      grantsRetained: NUMBER_SCHEMA,
      capturesRemoved: arraySchema(DEVICE_ARTIFACT_REMOVAL_SCHEMA),
      capturesRetained: NUMBER_SCHEMA,
      bytesReclaimed: NUMBER_SCHEMA,
    }, ['summary', 'sweptAt', 'grantsRemoved', 'grantsRetained', 'capturesRemoved', 'capturesRetained', 'bytesReclaimed']),
  }),
];
