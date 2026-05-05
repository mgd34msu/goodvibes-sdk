import type { DaemonIntegrationRouteHandlers } from './context.js';
import { jsonErrorResponse } from './error-response.js';
import type { DaemonIntegrationRouteContext, IntegrationHelperServiceLike, RuntimeEventDomain } from './integration-route-types.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readOptionalStringField,
  readStringArrayField,
} from './route-helpers.js';

const MAX_LOCAL_AUTH_ROLES = 32;

type EmbeddingDefaultBody = {
  readonly providerId: string;
};

type LocalAuthUserBody = {
  readonly username: string;
  readonly password: string;
  readonly roles: readonly string[];
};

type LocalAuthPasswordBody = {
  readonly password: string;
};

type PanelOpenBody = {
  readonly panelId: string;
  readonly pane: 'top' | 'bottom';
};

const integrationBodySchemas = createRouteBodySchemaRegistry({
  embeddingDefault: createRouteBodySchema<EmbeddingDefaultBody>('POST /api/memory/embedding/default', (body) => {
    const providerId = readOptionalStringField(body, 'providerId');
    if (!providerId) return jsonErrorResponse({ error: 'Missing providerId' }, { status: 400 });
    return { providerId };
  }),
  localAuthUser: createRouteBodySchema<LocalAuthUserBody>('POST /api/local-auth/users', (body) => {
    const username = readOptionalStringField(body, 'username');
    const password = readOptionalStringField(body, 'password');
    if (!username) return jsonErrorResponse({ error: 'Missing username' }, { status: 400 });
    if (!password) return jsonErrorResponse({ error: 'Missing password' }, { status: 400 });
    return {
      username,
      password,
      roles: readStringArrayField(body, 'roles', MAX_LOCAL_AUTH_ROLES) ?? ['admin'],
    };
  }),
  localAuthPassword: createRouteBodySchema<LocalAuthPasswordBody>('POST /api/local-auth/users/:username/password', (body) => {
    const password = readOptionalStringField(body, 'password');
    if (!password) return jsonErrorResponse({ error: 'Missing password' }, { status: 400 });
    return { password };
  }),
  panelOpen: createRouteBodySchema<PanelOpenBody>('POST /api/integrations/panels/open', (body) => {
    const panelId = readOptionalStringField(body, 'id');
    if (!panelId) return jsonErrorResponse({ error: 'Missing panel id' }, { status: 400 });
    return {
      panelId,
      pane: body.pane === 'bottom' ? 'bottom' : 'top',
    };
  }),
});

export function createDaemonIntegrationRouteHandlers(
  context: DaemonIntegrationRouteContext,
): DaemonIntegrationRouteHandlers {
  return {
    getReview: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.buildReview())),
    getIntegrationSession: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSessionSnapshot())),
    getIntegrationTasks: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getTaskSnapshot())),
    getIntegrationAutomation: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getAutomationSnapshot())),
    getIntegrationSessions: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSessionBrokerSnapshot())),
    getDeliveries: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getDeliverySnapshot())),
    getDelivery: (deliveryId) => {
      const runtimeStore = context.integrationHelpers?.getRuntimeStore() ?? null;
      const delivery = runtimeStore?.getState().deliveries.deliveryAttempts.get(deliveryId);
      if (!delivery) {
        return jsonErrorResponse({ error: 'Unknown delivery' }, { status: 404 });
      }
      return Response.json({ delivery });
    },
    getRoutesSnapshot: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getRouteSnapshot())),
    getRemote: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getRemoteSnapshot())),
    getHealth: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getHealthSnapshot())),
    getAccounts: async () => {
      if (!context.integrationHelpers) {
        return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      return Response.json(await context.integrationHelpers.getAccountsSnapshot());
    },
    getProviders: async () => Response.json({ providers: await context.providerRuntime.listSnapshots() }),
    getProvider: async (providerId) => {
      const provider = await context.providerRuntime.getSnapshot(providerId);
      return provider
        ? Response.json(provider)
        : jsonErrorResponse({ error: 'Unknown provider' }, { status: 404 });
    },
    getProviderUsage: async (providerId) => {
      const usage = await context.providerRuntime.getUsageSnapshot(providerId);
      return usage
        ? Response.json(usage)
        : jsonErrorResponse({ error: 'Unknown provider' }, { status: 404 });
    },
    getSettings: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSettingsSnapshot())),
    getSecuritySettings: () => withHelpers(context.integrationHelpers, (helpers) => Response.json({
      settings: helpers.getSecuritySettingsReport(),
    })),
    getContinuity: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getContinuitySnapshot())),
    getWorktrees: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getWorktreeSnapshot())),
    getIntelligence: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getIntelligenceSnapshot())),
    getMemoryDoctor: async () => Response.json(await context.memoryRegistry.doctor()),
    getMemoryVectorStats: () => Response.json({ vector: context.memoryRegistry.vectorStats() }),
    postMemoryVectorRebuild: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ vector: await context.memoryRegistry.rebuildVectorsAsync() });
    },
    postMemoryEmbeddingDefault: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.embeddingDefault.parse(body);
      if (input instanceof Response) return input;
      try {
        context.memoryEmbeddingRegistry.setDefaultProvider(input.providerId);
        return Response.json(await context.memoryRegistry.doctor());
      } catch (error) {
        return jsonErrorResponse(error, { status: 400 });
      }
    },
    getLocalAuth: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getLocalAuthSnapshot()));
    },
    postLocalAuthUser: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.localAuthUser.parse(body);
      if (input instanceof Response) return input;
      try {
        return Response.json({ user: context.userAuth.addUser(input.username, input.password, input.roles) }, { status: 201 });
      } catch (error) {
        return jsonErrorResponse(error, { status: 400 });
      }
    },
    deleteLocalAuthUser: (username, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      try {
        const removed = context.userAuth.deleteUser(username);
        return removed
          ? Response.json({ deleted: true })
          : jsonErrorResponse({ error: 'Unknown user' }, { status: 404 });
      } catch (error) {
        return jsonErrorResponse(error, { status: 400 });
      }
    },
    postLocalAuthPassword: async (username, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.localAuthPassword.parse(body);
      if (input instanceof Response) return input;
      try {
        context.userAuth.rotatePassword(username, input.password);
        return Response.json({ rotated: true });
      } catch (error) {
        return jsonErrorResponse(error, { status: 400 });
      }
    },
    deleteLocalAuthSession: (sessionId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return context.userAuth.revokeSession(sessionId)
        ? Response.json({ revoked: true })
        : jsonErrorResponse({ error: 'Unknown session' }, { status: 404 });
    },
    deleteBootstrapFile: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ removed: context.userAuth.clearBootstrapCredentialFile() });
    },
    getPanels: () => withHelpers(context.integrationHelpers, (helpers) => Response.json({ panels: helpers.listPanels() })),
    postPanelOpen: async (req) => {
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.panelOpen.parse(body);
      if (input instanceof Response) return input;
      const ok = context.integrationHelpers?.openPanel(input.panelId, input.pane) ?? false;
      return ok
        ? Response.json({ opened: true, id: input.panelId, pane: input.pane })
        : jsonErrorResponse({ error: `Unknown panel: ${input.panelId}` }, { status: 404 });
    },
    getEvents: (req) => {
      const url = new URL(req.url);
      const rawDomains = url.searchParams.get('domains');
      const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
      return withHelpers(context.integrationHelpers, (helpers) => helpers.createEventStream(req, domains));
    },
  };
}

function withHelpers<T>(
  helpers: IntegrationHelperServiceLike | null | undefined,
  run: (helpers: IntegrationHelperServiceLike) => T,
): T | Response {
  if (!helpers) {
    return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
  }
  return run(helpers);
}
