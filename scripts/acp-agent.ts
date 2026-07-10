#!/usr/bin/env bun
/**
 * acp-agent.ts — run GoodVibes as an ACP agent over stdio.
 *
 * ACP-capable editors (Zed and others) spawn this entry point and drive
 * GoodVibes through the Agent Client Protocol: initialize → session/new
 * (against the editor's cwd) → session/prompt with streamed
 * agent_message_chunk / tool_call updates → session/request_permission mapped
 * onto the platform permission callback.
 *
 * Usage (editor agent-server command):
 *   bun scripts/acp-agent.ts
 *
 * Environment:
 *   GOODVIBES_HOME — home directory for the embedded daemon (default: $HOME).
 */

import { serveAcpAgent } from '../packages/sdk/src/platform/acp/agent.ts';

const { dispose } = serveAcpAgent({
  homeDirectory: process.env.GOODVIBES_HOME ?? process.env.HOME ?? process.cwd(),
});

async function shutdown(code: number): Promise<void> {
  await dispose().catch(() => {});
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.stdin.on('end', () => void shutdown(0));
