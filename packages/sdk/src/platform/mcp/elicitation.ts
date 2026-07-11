// MCP elicitation → the one approval broker.
//
// STANDING RULE: an MCP server's `elicitation/create` request (the spec's
// ask-the-user channel) must reach the model and the human through the SAME
// approval broker as a permission ask — not a separate, unrendered path and not
// a silent `-32601` drop. This module is the translation seam: it turns an
// incoming elicitation request into a `PermissionPromptRequest` (attributed to
// the MCP server) and turns the broker's approve/deny decision back into the
// MCP elicitation response shape. Every surface's existing approval UI then
// renders it and background-agent bubbling applies, for free.
import { randomUUID } from 'node:crypto';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../permissions/prompt.js';

/**
 * The MCP `elicitation/create` request, already parsed out of the raw JSON-RPC
 * params. `message` is the human-facing prompt the server wants answered;
 * `requestedSchema` is the JSON Schema of the structured content it expects
 * (retained verbatim so a surface can render a form and so nothing is
 * fabricated). `rawParams` is the untouched params object for provenance.
 */
export interface McpElicitationRequest {
  readonly serverName: string;
  readonly message: string;
  readonly requestedSchema?: Record<string, unknown> | undefined;
  readonly rawParams?: unknown | undefined;
}

/**
 * The MCP elicitation response. `action` follows the spec's tri-state; the
 * broker is an approve/deny channel, so an approval maps to `accept` (carrying
 * any surface-provided `content` from the decision's modifiedArgs) and a denial
 * maps to `decline`. `cancel` is reserved for the request being cancelled or
 * expired out from under us.
 */
export interface McpElicitationOutcome {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Record<string, unknown> | undefined;
}

/** Resolves an elicitation request to an outcome (the broker-backed handler). */
export type McpElicitationHandler = (
  request: McpElicitationRequest,
) => Promise<McpElicitationOutcome>;

/** Parse a raw JSON-RPC `elicitation/create` params object into a typed request. */
export function parseElicitationParams(serverName: string, params: unknown): McpElicitationRequest {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const message = typeof record['message'] === 'string' && record['message'].trim().length > 0
    ? record['message']
    : `MCP server "${serverName}" is requesting input.`;
  const requestedSchema = record['requestedSchema'] && typeof record['requestedSchema'] === 'object'
    ? (record['requestedSchema'] as Record<string, unknown>)
    : undefined;
  return {
    serverName,
    message,
    ...(requestedSchema ? { requestedSchema } : {}),
    ...(params !== undefined ? { rawParams: params } : {}),
  };
}

/**
 * Build the broker-backed elicitation handler. Every incoming elicitation
 * becomes a `PermissionPromptRequest` in the `delegate` category (an MCP server
 * asking the operator to act is a delegation, not a filesystem/exec/network
 * op), attributed to the server, and is resolved by `requestApproval`. Approve
 * → `accept`; deny/cancel/expire → `decline`.
 */
export function createMcpElicitationApprovalHandler(
  requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>,
): McpElicitationHandler {
  return async (request) => {
    const promptRequest: PermissionPromptRequest = {
      callId: `mcp-elicit-${randomUUID().slice(0, 8)}`,
      tool: `mcp:${request.serverName}:elicitation`,
      args: {
        message: request.message,
        ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
      },
      category: 'delegate',
      analysis: {
        classification: 'mcp-elicitation',
        riskLevel: 'medium',
        summary: `MCP server "${request.serverName}" requests input: ${request.message}`,
        reasons: [
          `The "${request.serverName}" MCP server issued an elicitation/create request.`,
          'Approving returns your input to the server; declining refuses it.',
        ],
        surface: 'platform',
        blastRadius: 'external',
      },
      attribution: { kind: 'mcp-server', serverName: request.serverName },
    };
    const decision = await requestApproval({
      request: promptRequest,
      metadata: { source: 'mcp-elicitation', serverName: request.serverName },
    });
    if (!decision.approved) {
      return { action: 'decline' };
    }
    // The approving surface may return structured content via modifiedArgs; if it
    // does, hand it back to the server verbatim. Otherwise accept with no content
    // (the honest default — we never fabricate field values the human did not
    // supply).
    const content = decision.modifiedArgs && typeof decision.modifiedArgs === 'object'
      ? (decision.modifiedArgs as Record<string, unknown>)
      : undefined;
    return { action: 'accept', ...(content ? { content } : {}) };
  };
}
