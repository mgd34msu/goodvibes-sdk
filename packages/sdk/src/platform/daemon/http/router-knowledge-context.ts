/**
 * router-knowledge-context.ts, the knowledge route context, built once.
 *
 * The daemon serves knowledge routes on two surfaces: the operator's, and the
 * agent-aliased one under `/api/goodvibes-agent/knowledge`. They differ ONLY in
 * which knowledge service and GraphQL facade they point at, every other field
 * was written out twice, verbatim, in the router. Two places to keep in step
 * and one to forget.
 *
 * Lifted out of router.ts rather than kept there as a private method because
 * that file sits at its size ceiling, and this is the block that most obviously
 * did not need to be in it.
 */
import {
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
} from '../../automation/index.js';
import { inspectKnowledgeGraphqlAccess } from '../../knowledge/index.js';
import { buildKnowledgeRouteContext } from './router-route-contexts.js';

type KnowledgeContextInput = Parameters<typeof buildKnowledgeRouteContext>[0];

/**
 * The slice of the router's context this needs.
 *
 * Structural rather than the router's own context type, which is not exported,
 * and narrower is better here anyway: this function has no business reaching
 * anything else on it.
 */
export interface KnowledgeRouterContext {
  readonly artifactStore: KnowledgeContextInput['artifactStore'];
  readonly configManager: KnowledgeContextInput['configManager'];
  readonly requireAdmin: KnowledgeContextInput['requireAdmin'];
  extractAuthToken(request: Request): string | null;
  describeAuthenticatedPrincipal(
    token: string,
  ): ReturnType<KnowledgeContextInput['resolveAuthenticatedPrincipal']>;
}

/** The router's own JSON body helpers, which are instance methods. */
export interface RouterBodyParsers {
  readonly parseJsonBody: KnowledgeContextInput['parseJsonBody'];
  readonly parseOptionalJsonBody: KnowledgeContextInput['parseOptionalJsonBody'];
  readonly parseJsonText: KnowledgeContextInput['parseJsonText'];
}

/** Build the context for one knowledge surface. */
export function buildRouterKnowledgeContext(
  context: KnowledgeRouterContext,
  parsers: RouterBodyParsers,
  knowledgeService: KnowledgeContextInput['knowledgeService'],
  knowledgeGraphqlService: KnowledgeContextInput['knowledgeGraphqlService'],
): ReturnType<typeof buildKnowledgeRouteContext> {
  return buildKnowledgeRouteContext({
    artifactStore: context.artifactStore,
    configManager: context.configManager,
    inspectGraphqlAccess: inspectKnowledgeGraphqlAccess,
    normalizeAtSchedule,
    normalizeEverySchedule,
    normalizeCronSchedule,
    parseJsonBody: parsers.parseJsonBody,
    parseOptionalJsonBody: parsers.parseOptionalJsonBody,
    parseJsonText: parsers.parseJsonText,
    requireAdmin: context.requireAdmin,
    resolveAuthenticatedPrincipal: (request) => {
      const token = context.extractAuthToken(request);
      return token ? context.describeAuthenticatedPrincipal(token) : null;
    },
    knowledgeService,
    knowledgeGraphqlService,
  });
}
