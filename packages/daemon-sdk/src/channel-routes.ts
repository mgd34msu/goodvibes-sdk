import { randomUUID } from 'node:crypto';
import type { DaemonChannelRouteHandlers } from './context.js';
import { jsonErrorResponse } from './error-response.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedPositiveInteger,
  readChannelConversationKind,
  readChannelLifecycleAction,
  type JsonRecord,
} from './route-helpers.js';
import type { ChannelDirectoryScope, ChannelSurface, DaemonChannelRouteContext } from './channel-route-types.js';

type OptionalChannelBody = JsonRecord | undefined;

const channelBodySchemas = createRouteBodySchemaRegistry({
  optional: createRouteBodySchema<OptionalChannelBody>('POST /api/channels/* optional body', (body) => body),
});

async function readOptionalChannelBody(
  context: DaemonChannelRouteContext,
  req: Request,
): Promise<OptionalChannelBody | Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  if (body === null) return undefined;
  return channelBodySchemas.optional.parse(body);
}

export function createDaemonChannelRouteHandlers(
  context: DaemonChannelRouteContext,
): DaemonChannelRouteHandlers {
  return {
    getSurfaces: () => Response.json({ surfaces: context.surfaceRegistry.list() }),
    getChannelAccounts: () => context.channelPlugins.listAccounts().then((accounts) => Response.json({ accounts })),
    getChannelSurfaceAccounts: (surface) => context.channelPlugins
      .listAccounts(surface as ChannelSurface)
      .then((accounts) => Response.json({ accounts })),
    getChannelAccount: async (surface, accountId) => {
      const account = await context.channelPlugins.getAccount(
        surface as ChannelSurface,
        accountId,
      );
      return account
        ? Response.json(account)
        : jsonErrorResponse({ error: 'Unknown channel account' }, { status: 404 });
    },
    getChannelSetupSchema: async (surface, url) => {
      const schema = await context.channelPlugins.getSetupSchema(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      );
      return schema
        ? Response.json(schema)
        : jsonErrorResponse({ error: 'Unknown channel setup schema' }, { status: 404 });
    },
    getChannelDoctor: async (surface, url) => {
      const report = await context.channelPlugins.doctor(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      );
      return report
        ? Response.json(report)
        : jsonErrorResponse({ error: 'Unknown channel doctor surface' }, { status: 404 });
    },
    getChannelRepairActions: async (surface, url) => Response.json({
      actions: await context.channelPlugins.listRepairActions(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      ),
    }),
    getChannelLifecycle: async (surface, url) => {
      const state = await context.channelPlugins.getLifecycleState(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      );
      return state
        ? Response.json(state)
        : jsonErrorResponse({ error: 'Unknown channel lifecycle surface' }, { status: 404 });
    },
    postChannelAccountAction: async (surface, accountId, action, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const input = await readOptionalChannelBody(context, req);
      if (input instanceof Response) return input;
      const lifecycleAction = readChannelLifecycleAction(action);
      if (!lifecycleAction) {
        return jsonErrorResponse({ error: 'Unknown channel account action' }, { status: 400 });
      }
      const result = await context.channelPlugins.runAccountAction(
        surface as ChannelSurface,
        lifecycleAction,
        accountId ?? (typeof input?.accountId === 'string' ? input.accountId : undefined),
        input,
      );
      return result !== null
        ? Response.json({ surface, accountId, action: lifecycleAction, result })
        : jsonErrorResponse({ error: 'Unknown channel account action' }, { status: 404 });
    },
    getChannelCapabilities: () => context.channelPlugins.listCapabilities().then((capabilities) => Response.json({ capabilities })),
    getChannelSurfaceCapabilities: (surface) => context.channelPlugins
      .listCapabilities(surface as ChannelSurface)
      .then((capabilities) => Response.json({ capabilities })),
    getChannelTools: () => context.channelPlugins.listTools().then((tools) => Response.json({ tools })),
    getChannelSurfaceTools: (surface) => context.channelPlugins
      .listTools(surface as ChannelSurface)
      .then((tools) => Response.json({ tools })),
    getChannelAgentTools: () => Response.json({ tools: context.channelPlugins.listAgentTools().map((tool) => tool.definition) }),
    getChannelSurfaceAgentTools: (surface) => Response.json({
      tools: context.channelPlugins
        .listAgentTools(surface as ChannelSurface)
        .map((tool) => tool.definition),
    }),
    postChannelTool: async (surface, toolId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const input = await readOptionalChannelBody(context, req);
      if (input instanceof Response) return input;
      const result = await context.channelPlugins.runTool(
        surface as ChannelSurface,
        toolId,
        input,
      );
      return result !== null
        ? Response.json({ toolId, surface, result })
        : jsonErrorResponse({ error: 'Unknown channel tool' }, { status: 404 });
    },
    getChannelActions: () => context.channelPlugins.listOperatorActions().then((actions) => Response.json({ actions })),
    getChannelSurfaceActions: (surface) => context.channelPlugins
      .listOperatorActions(surface as ChannelSurface)
      .then((actions) => Response.json({ actions })),
    postChannelAction: async (surface, actionId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const input = await readOptionalChannelBody(context, req);
      if (input instanceof Response) return input;
      const result = await context.channelPlugins.runOperatorAction(
        surface as ChannelSurface,
        actionId,
        input,
      );
      return result !== null
        ? Response.json({ actionId, surface, result })
        : jsonErrorResponse({ error: 'Unknown channel action' }, { status: 404 });
    },
    postChannelResolveTarget: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const targetInput = typeof body.target === 'string'
        ? body.target
        : typeof body.input === 'string'
          ? body.input
          : typeof body.query === 'string'
            ? body.query
            : '';
      if (!targetInput.trim()) {
        return jsonErrorResponse({ error: 'Target resolution requires target, input, or query.' }, { status: 400 });
      }
      const preferredKind = readChannelConversationKind(body.preferredKind);
      const target = await context.channelPlugins.resolveTarget(
        surface as ChannelSurface,
        {
          input: targetInput,
          ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
          ...(preferredKind ? { preferredKind } : {}),
          ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof body.createIfMissing === 'boolean' ? { createIfMissing: body.createIfMissing } : {}),
          ...(typeof body.live === 'boolean' ? { live: body.live } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        },
      );
      return target
        ? Response.json({ surface, target })
        : jsonErrorResponse({ error: 'Unable to resolve channel target' }, { status: 404 });
    },
    postChannelAuthorize: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const target = typeof body.target === 'string' && body.target.trim()
        ? await context.channelPlugins.resolveTarget(
            surface as ChannelSurface,
            {
              input: body.target,
              ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
              createIfMissing: true,
            },
          )
        : null;
      const result = await context.channelPlugins.authorizeActorAction(
        surface as ChannelSurface,
        {
          actionId: typeof body.actionId === 'string' ? body.actionId : 'unknown',
          ...(typeof body.actorId === 'string' ? { actorId: body.actorId } : {}),
          ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
          ...(target ? { target } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        },
      );
      return result
        ? Response.json({ surface, result })
        : jsonErrorResponse({ error: 'Unable to authorize channel action' }, { status: 404 });
    },
    postChannelAllowlistResolve: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const result = await context.channelPlugins.resolveAllowlist(
        surface as ChannelSurface,
        {
          ...(Array.isArray(body.add) ? { add: body.add.filter((value): value is string => typeof value === 'string') } : {}),
          ...(Array.isArray(body.remove) ? { remove: body.remove.filter((value): value is string => typeof value === 'string') } : {}),
          ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
          ...(typeof body.channelId === 'string' ? { channelId: body.channelId } : {}),
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(body.kind === 'user' || body.kind === 'channel' || body.kind === 'group' ? { kind: body.kind } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        },
      );
      return result
        ? Response.json(result)
        : jsonErrorResponse({ error: 'Unknown channel allowlist surface' }, { status: 404 });
    },
    postChannelAllowlistEdit: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const result = await context.channelPlugins.editAllowlist(
        surface as ChannelSurface,
        {
          ...(Array.isArray(body.add) ? { add: body.add.filter((value): value is string => typeof value === 'string') } : {}),
          ...(Array.isArray(body.remove) ? { remove: body.remove.filter((value): value is string => typeof value === 'string') } : {}),
          ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
          ...(typeof body.channelId === 'string' ? { channelId: body.channelId } : {}),
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(body.kind === 'user' || body.kind === 'channel' || body.kind === 'group' ? { kind: body.kind } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        },
      );
      return result
        ? Response.json(result)
        : jsonErrorResponse({ error: 'Unknown channel allowlist surface' }, { status: 404 });
    },
    getChannelPolicies: () => Response.json({ policies: context.channelPolicy.listPolicies() }),
    patchChannelPolicy: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const updated = await context.channelPolicy.upsertPolicy(surface as ChannelSurface, {
        ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
        ...(body.requireMention !== undefined ? { requireMention: Boolean(body.requireMention) } : {}),
        ...(body.allowDirectMessages !== undefined ? { allowDirectMessages: Boolean(body.allowDirectMessages) } : {}),
        ...(body.allowGroupMessages !== undefined ? { allowGroupMessages: Boolean(body.allowGroupMessages) } : {}),
        ...(body.allowThreadMessages !== undefined ? { allowThreadMessages: Boolean(body.allowThreadMessages) } : {}),
        ...(body.dmPolicy === 'allow' || body.dmPolicy === 'deny' || body.dmPolicy === 'inherit' ? { dmPolicy: body.dmPolicy } : {}),
        ...(body.groupPolicy === 'allow' || body.groupPolicy === 'deny' || body.groupPolicy === 'inherit' ? { groupPolicy: body.groupPolicy } : {}),
        ...(body.allowTextCommandsWithoutMention !== undefined ? { allowTextCommandsWithoutMention: Boolean(body.allowTextCommandsWithoutMention) } : {}),
        ...(Array.isArray(body.allowlistUserIds) ? { allowlistUserIds: body.allowlistUserIds.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.allowlistChannelIds) ? { allowlistChannelIds: body.allowlistChannelIds.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.allowlistGroupIds) ? { allowlistGroupIds: body.allowlistGroupIds.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.allowedCommands) ? { allowedCommands: body.allowedCommands.filter((value): value is string => typeof value === 'string') } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return Response.json(updated);
    },
    postChannelPolicy: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const updated = await context.channelPolicy.upsertPolicy(surface as ChannelSurface, {
        ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
        ...(body.requireMention !== undefined ? { requireMention: Boolean(body.requireMention) } : {}),
        ...(body.allowDirectMessages !== undefined ? { allowDirectMessages: Boolean(body.allowDirectMessages) } : {}),
        ...(body.allowGroupMessages !== undefined ? { allowGroupMessages: Boolean(body.allowGroupMessages) } : {}),
        ...(body.allowThreadMessages !== undefined ? { allowThreadMessages: Boolean(body.allowThreadMessages) } : {}),
        ...(body.dmPolicy === 'allow' || body.dmPolicy === 'deny' || body.dmPolicy === 'inherit' ? { dmPolicy: body.dmPolicy } : {}),
        ...(body.groupPolicy === 'allow' || body.groupPolicy === 'deny' || body.groupPolicy === 'inherit' ? { groupPolicy: body.groupPolicy } : {}),
        ...(body.allowTextCommandsWithoutMention !== undefined ? { allowTextCommandsWithoutMention: Boolean(body.allowTextCommandsWithoutMention) } : {}),
        ...(Array.isArray(body.allowlistUserIds) ? { allowlistUserIds: body.allowlistUserIds.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.allowlistChannelIds) ? { allowlistChannelIds: body.allowlistChannelIds.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.allowlistGroupIds) ? { allowlistGroupIds: body.allowlistGroupIds.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.allowedCommands) ? { allowedCommands: body.allowedCommands.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(body.groupPolicies) ? {
          groupPolicies: body.groupPolicies
            .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
            .map((value) => ({
              id: typeof value.id === 'string' ? value.id : `group-policy-${randomUUID().slice(0, 8)}`,
              ...(typeof value.label === 'string' ? { label: value.label } : {}),
              ...(typeof value.groupId === 'string' ? { groupId: value.groupId } : {}),
              ...(typeof value.channelId === 'string' ? { channelId: value.channelId } : {}),
              ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
              ...(value.requireMention !== undefined ? { requireMention: Boolean(value.requireMention) } : {}),
              ...(value.allowGroupMessages !== undefined ? { allowGroupMessages: Boolean(value.allowGroupMessages) } : {}),
              ...(value.allowThreadMessages !== undefined ? { allowThreadMessages: Boolean(value.allowThreadMessages) } : {}),
              ...(value.allowTextCommandsWithoutMention !== undefined ? { allowTextCommandsWithoutMention: Boolean(value.allowTextCommandsWithoutMention) } : {}),
              ...(Array.isArray(value.allowlistUserIds) ? { allowlistUserIds: value.allowlistUserIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
              ...(Array.isArray(value.allowlistChannelIds) ? { allowlistChannelIds: value.allowlistChannelIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
              ...(Array.isArray(value.allowlistGroupIds) ? { allowlistGroupIds: value.allowlistGroupIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
              ...(Array.isArray(value.allowedCommands) ? { allowedCommands: value.allowedCommands.filter((entry): entry is string => typeof entry === 'string') } : {}),
              ...(typeof value.metadata === 'object' && value.metadata !== null ? { metadata: value.metadata as Record<string, unknown> } : {}),
            })),
        } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return Response.json(updated);
    },
    getChannelPolicyAudit: (limit) => Response.json({ audit: context.channelPolicy.listAudit(limit) }),
    getChannelStatus: () => context.channelPlugins.listStatus().then((channels) => Response.json({ channels })),
    getChannelDirectory: (surface, url) => context.channelPlugins.queryDirectory(
      surface as ChannelSurface,
      {
        query: url.searchParams.get('q') ?? '',
        ...(url.searchParams.get('scope') ? { scope: url.searchParams.get('scope') as ChannelDirectoryScope } : {}),
        ...(url.searchParams.get('groupId') ? { groupId: url.searchParams.get('groupId') as string } : {}),
        ...(url.searchParams.get('limit') ? { limit: readBoundedPositiveInteger(url.searchParams.get('limit'), 100) } : {}),
        ...(url.searchParams.get('live') ? { live: url.searchParams.get('live') === 'true' } : {}),
      },
    ).then((entries) => Response.json({ entries })),
  };
}
