/**
 * routes/skills.ts
 *
 * Handlers for the skills.* gateway verbs over the canonical `SkillService`
 * (../../skills, service.ts). Thin verb registration, not new machinery: each
 * handler reads the invocation params, calls the service, and maps a
 * `SkillServiceError` to an honest wire status (INVALID_ARGUMENT -> 400,
 * NOT_FOUND -> 404, ALREADY_EXISTS -> 409).
 *
 * Wired via `GatewayMethodCatalog.register(descriptor, handler)` — the same
 * mechanism fleet.* / checkpoints.* / push.* use — against descriptors already
 * cataloged (without a handler) from ../method-catalog-skills.ts. Attaching the
 * handler and the descriptor together is what keeps a skills verb from being a
 * cataloged-but-unhandled 501.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { SkillFrontmatterValue } from '../../skills/index.js';
import { SkillService, SkillServiceError } from '../../skills/index.js';

/** The subset of SkillService the verb handlers need. */
export type SkillsGatewayService = Pick<SkillService, 'list' | 'get' | 'create' | 'update' | 'delete'>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
};

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof SkillServiceError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400);
  }
  throw error;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

/** Coerce an untyped wire value into the frontmatter metadata shape (string / string[] values only). */
function readMetadata(value: unknown): Readonly<Record<string, SkillFrontmatterValue>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayVerbError('metadata must be an object', 'INVALID_ARGUMENT', 400);
  }
  const out: Record<string, SkillFrontmatterValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
      out[key] = raw as string[];
    } else {
      throw new GatewayVerbError(`metadata.${key} must be a string or string array`, 'INVALID_ARGUMENT', 400);
    }
  }
  return out;
}

function createSkillsListHandler(service: SkillsGatewayService): GatewayMethodHandler {
  return async () => ({ skills: await service.list() });
}

function createSkillsGetHandler(service: SkillsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = requireString(params.name, 'name');
    try {
      return { skill: await service.get(name) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSkillsCreateHandler(service: SkillsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const skill = await service.create({
        name: requireString(params.name, 'name'),
        description: requireString(params.description, 'description'),
        body: typeof params.body === 'string' ? params.body : '',
        metadata: readMetadata(params.metadata),
      });
      return { skill };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSkillsUpdateHandler(service: SkillsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = requireString(params.name, 'name');
    try {
      const skill = await service.update(name, {
        description: typeof params.description === 'string' ? params.description : undefined,
        body: typeof params.body === 'string' ? params.body : undefined,
        metadata: readMetadata(params.metadata),
      });
      return { skill };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSkillsDeleteHandler(service: SkillsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = requireString(params.name, 'name');
    try {
      return await service.delete(name);
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

/**
 * Attach the skills.* handlers to the descriptors already registered (without a
 * handler) from ../method-catalog-skills.ts. A missing descriptor
 * (contract/registration drift) is a silent no-op rather than a throw —
 * construction must never fail because a wire verb failed to register; the
 * operator-contract gates catch a real drift.
 */
export function registerSkillsGatewayMethods(catalog: GatewayMethodCatalog, service: SkillsGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('skills.list', createSkillsListHandler(service));
  attach('skills.get', createSkillsGetHandler(service));
  attach('skills.create', createSkillsCreateHandler(service));
  attach('skills.update', createSkillsUpdateHandler(service));
  attach('skills.delete', createSkillsDeleteHandler(service));
}
