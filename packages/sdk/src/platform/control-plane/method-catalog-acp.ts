/**
 * method-catalog-acp.ts
 *
 * Hosted third-party coding agents (Claude Code, Codex CLI, opencode) over the
 * Agent Client Protocol: read-only discovery of installed agents, and the
 * one-act spawn that turns a discovered agent + working directory into a
 * hosted daemon session that appears as a steerable/stoppable fleet row.
 *
 * Like the other handler-registered verb groups these declare
 * `transport: ['ws']` and are served through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint.
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

const DISCOVERED_ACP_AGENT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  binaryPath: STRING_SCHEMA,
  args: arraySchema(STRING_SCHEMA),
}, ['id', 'title', 'binaryPath', 'args']);

/** The structured, user-renderable handshake failure — which binary, which stage, what happened. */
const ACP_HOST_ERROR_SCHEMA = objectSchema({
  binary: STRING_SCHEMA,
  stage: STRING_SCHEMA,
  message: STRING_SCHEMA,
}, ['binary', 'stage', 'message']);

const HOSTED_ACP_AGENT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  binaryPath: STRING_SCHEMA,
  cwd: STRING_SCHEMA,
  state: STRING_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  progress: STRING_SCHEMA,
  pendingPermission: STRING_SCHEMA,
  error: ACP_HOST_ERROR_SCHEMA,
  promptCount: NUMBER_SCHEMA,
}, ['id', 'agentId', 'title', 'binaryPath', 'cwd', 'state', 'startedAt', 'promptCount']);

export const builtinGatewayAcpMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'acp.agents.list',
    title: 'List Installed Third-Party Coding Agents',
    description: 'READ-ONLY discovery of installed ACP-capable third-party coding agents (Claude Code, Codex CLI, opencode): existence checks over $PATH and known install directories — no process is ever executed, no registration ceremony. Returns only what is present (id, title, resolved binary path, ACP launch args); absence is a quiet empty list, never a nag.',
    category: 'acp',
    scopes: ['read:fleet'],
    transport: ['ws'],
    outputSchema: objectSchema({
      agents: arraySchema(DISCOVERED_ACP_AGENT_SCHEMA),
    }, ['agents']),
  }),
  methodDescriptor({
    id: 'acp.sessions.create',
    title: 'Spawn a Third-Party Coding Agent Session',
    description: 'Spawn a discovered third-party agent into a working directory as a hosted daemon session in ONE act: the binary is launched in ACP stdio mode, the handshake and session creation run under a bound timeout, and the result is the hosted record — which appears as a steerable/stoppable fleet row (kind acp-agent) whose permission asks classify as waiting-on-human. A binary that fails the handshake returns the SAME record with state "failed" and a structured error (which binary, which stage, what happened) — an honest outcome, never a hung row and never a bare string. An optional initial prompt starts the first turn.',
    category: 'acp',
    scopes: ['write:fleet'],
    transport: ['ws'],
    inputSchema: objectSchema({
      agentId: STRING_SCHEMA,
      cwd: STRING_SCHEMA,
      title: STRING_SCHEMA,
      prompt: STRING_SCHEMA,
    }, ['agentId', 'cwd']),
    outputSchema: objectSchema({
      hosted: HOSTED_ACP_AGENT_SCHEMA,
      // Convenience mirror of hosted.state !== 'failed' so a surface can gate
      // its rendering without string comparison.
      started: BOOLEAN_SCHEMA,
    }, ['hosted', 'started']),
  }),
];
