/**
 * method-catalog-devices.ts — paired-device verbs.
 *
 * The operator-contract surface for the paired-phone capability feature: which
 * device nodes are paired and what each can serve, the durable "always allow"
 * grants with the ledger behind them, revoking a grant, and running the
 * housekeeping sweep on demand with its disclosure.
 *
 * The grants surface in any client renders from these verbs, so "visible and
 * revocable in the grants surface" (owner ruling 2026-07-25) is one contract
 * every surface shares rather than a per-surface reimplementation.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
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
