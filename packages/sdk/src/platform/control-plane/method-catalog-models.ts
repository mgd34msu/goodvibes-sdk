/**
 * method-catalog-models.ts, the model catalog and the daemon's current model.
 *
 * Three routes that have been served and called for a long time,
 * `GET /api/models`, `GET /api/models/current`, `PATCH /api/models/current`
 * (platform/daemon/http/model-routes.ts), and which no method descriptor
 * described. Every generated client is derived from this catalog, so a route
 * outside it is a route each consumer has to hand-write a row for: the web
 * surface did exactly that, and a hand-written row is a second statement of the
 * same shape with nothing keeping the two in step.
 *
 * The shapes here are the ones packages/contracts/src/zod-schemas/providers.ts
 * already validates on the wire; this is the same contract expressed where the
 * generators can read it.
 *
 * `models.current.set` is a PATCH and NOT `models.select`: the id's verb tail is
 * the catalog's own vocabulary (core-verbs.ts), and setting the current model is
 * a plain `set` on one named thing. `select` would be a fourth word for it.
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

/** How a provider's credentials were supplied, when it has any. */
const CONFIGURED_VIA_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['env', 'secrets', 'subscription', 'anonymous'],
};

/** One model, named the way the registry names it. */
const PROVIDER_MODEL_REF_SCHEMA = objectSchema({
  registryKey: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  id: STRING_SCHEMA,
}, ['registryKey', 'provider', 'id']);

const PROVIDER_MODEL_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  registryKey: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  label: STRING_SCHEMA,
  contextWindow: NUMBER_SCHEMA,
}, ['id', 'registryKey', 'provider']);

/** One way a provider can be authenticated, and whether it currently is. */
const PROVIDER_AUTH_ROUTE_SCHEMA = objectSchema({
  route: { type: 'string', enum: ['api-key', 'secret-ref', 'service-oauth', 'subscription-oauth', 'anonymous', 'none'] },
  label: STRING_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  usable: BOOLEAN_SCHEMA,
  freshness: { type: 'string', enum: ['healthy', 'expiring', 'expired', 'pending', 'unconfigured'] },
  detail: STRING_SCHEMA,
  envVars: arraySchema(STRING_SCHEMA),
  secretKeys: arraySchema(STRING_SCHEMA),
  serviceNames: arraySchema(STRING_SCHEMA),
  providerId: STRING_SCHEMA,
  repairHints: arraySchema(STRING_SCHEMA),
}, ['route', 'label', 'configured']);

const PROVIDER_MODEL_PROVIDER_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  configuredVia: CONFIGURED_VIA_SCHEMA,
  envVars: arraySchema(STRING_SCHEMA),
  routes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
  models: arraySchema(PROVIDER_MODEL_ENTRY_SCHEMA),
}, ['id', 'label', 'configured', 'envVars', 'models']);

const CURRENT_MODEL_SCHEMA = objectSchema({
  model: { anyOf: [PROVIDER_MODEL_REF_SCHEMA, { type: 'null' }] },
  configured: BOOLEAN_SCHEMA,
  configuredVia: CONFIGURED_VIA_SCHEMA,
  routes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
}, ['model', 'configured']);

export const builtinGatewayModelMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'models.list',
    title: 'Model Catalog',
    description: 'Every provider this daemon knows about with the models it offers, whether it is configured, and how it was configured. A GET also triggers the TTL-respecting live-discovery re-check that the terminal\'s model picker triggers on open, so a locally served model that appeared since the last read shows up on the next one. `currentModel` is the daemon\'s current selection, or null when nothing is selected. `secretsResolutionSkipped` is true when secret-backed credentials were not resolved for this read, so a caller can tell "not configured" from "not checked".',
    category: 'providers',
    scopes: ['read:providers'],
    http: { method: 'GET', path: '/api/models' },
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      providers: arraySchema(PROVIDER_MODEL_PROVIDER_SCHEMA),
      currentModel: { anyOf: [PROVIDER_MODEL_REF_SCHEMA, { type: 'null' }] },
      secretsResolutionSkipped: BOOLEAN_SCHEMA,
    }, ['providers', 'currentModel', 'secretsResolutionSkipped']),
  }),
  methodDescriptor({
    id: 'models.current.get',
    title: 'Current Model',
    description: 'The model this daemon would use for a turn right now, with whether its provider is actually configured and by which authentication route. `model` is null when nothing is selected, which is a real state, not an error, and a caller rendering a picker needs to tell it from a selection whose provider has lost its credentials.',
    category: 'providers',
    scopes: ['read:providers'],
    http: { method: 'GET', path: '/api/models/current' },
    inputSchema: objectSchema({}, []),
    outputSchema: CURRENT_MODEL_SCHEMA,
  }),
  methodDescriptor({
    id: 'models.current.set',
    title: 'Switch the Current Model',
    description: 'Switch the daemon\'s current model live, by the registry key `models.list` returns. The switch applies to the next turn on every surface this daemon serves and is persisted, so it survives a restart; `persisted` says whether the write to settings succeeded. An unknown key is refused with MODEL_NOT_FOUND and a provider with no usable credentials with PROVIDER_NOT_CONFIGURED, naming the environment variables it looked for, a caller must not have to guess which of the two happened.',
    category: 'providers',
    scopes: ['write:providers'],
    dangerous: true,
    http: { method: 'PATCH', path: '/api/models/current' },
    inputSchema: objectSchema({ registryKey: STRING_SCHEMA }, ['registryKey']),
    outputSchema: objectSchema({
      model: { anyOf: [PROVIDER_MODEL_REF_SCHEMA, { type: 'null' }] },
      configured: BOOLEAN_SCHEMA,
      configuredVia: CONFIGURED_VIA_SCHEMA,
      routes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
      persisted: BOOLEAN_SCHEMA,
    }, ['model', 'configured', 'persisted']),
  }),
];
