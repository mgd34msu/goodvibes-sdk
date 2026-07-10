/**
 * routes/workspaces.ts
 *
 * Handlers for the registered-workspace registry verbs over
 * WorkspaceRegistrationStore. Thin verb registration: each handler reads the
 * invocation params, calls the store, and maps a WorkspaceRegistrationError to
 * an honest 400. Attached to the descriptors cataloged (without a handler) from
 * ../method-catalog-workspaces.ts, via the same GatewayMethodCatalog.register
 * mechanism skills.* / rewind.* use.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import {
  WorkspaceRegistrationError,
  type WorkspaceGitMetadata,
  type WorkspaceRegistrationStore,
} from '../../workspace/registration/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The subset of the store the verb handlers need. */
export type WorkspacesGatewayService = Pick<
  WorkspaceRegistrationStore,
  'snapshot' | 'add' | 'remove' | 'resolve'
>;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof WorkspaceRegistrationError) {
    throw new GatewayVerbError(error.message, error.code, 400);
  }
  throw error;
}

function createListHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async () => {
    const snapshot = await service.snapshot();
    return { workspaces: snapshot.workspaces, declines: snapshot.declines };
  };
}

function createAddHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const root = requireString(params.root, 'root');
    const label = optionalString(params.label);
    try {
      const result = await service.add(root, label !== undefined ? { label } : undefined);
      return { workspace: result.record, alreadyRegistered: result.alreadyRegistered };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createRemoveHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const root = requireString(params.root, 'root');
    return service.remove(root);
  };
}

function createResolveHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requireString(params.path, 'path');
    const mainWorktreeRoot = optionalString(params.mainWorktreeRoot);
    const git: WorkspaceGitMetadata | undefined =
      mainWorktreeRoot !== undefined ? { mainWorktreeRoot } : undefined;
    return service.resolve(path, git);
  };
}

/**
 * Attach the workspaces.* handlers to the descriptors already cataloged (without
 * a handler) from ../method-catalog-workspaces.ts. A missing descriptor is a
 * silent no-op — construction must never fail because a wire verb failed to
 * register; the operator-contract gates catch a real drift.
 */
export function registerWorkspacesGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: WorkspacesGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('workspaces.registrations.list', createListHandler(service));
  attach('workspaces.registrations.add', createAddHandler(service));
  attach('workspaces.registrations.remove', createRemoveHandler(service));
  attach('workspaces.resolve', createResolveHandler(service));
}
