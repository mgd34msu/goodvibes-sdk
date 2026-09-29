/**
 * Whether a parentless spawn should be rewritten into a write-review-fix-confirm
 * owner chain.
 *
 * Two very different signals can trigger that rewrite, and they carry different
 * authority:
 *
 * - A DECLARED role template (reviewer/tester/verifier/qa/review/test) is the
 *   caller saying what this agent IS. It still wins over a suppression flag:
 *   asking for a root reviewer agent and asking for no chain at the same time is
 *   exactly the role fragmentation the rewrite exists to correct.
 * - The task PROSE is a guess made from wording. A continuation prompt carries
 *   the whole chat transcript inside its task text, so one earlier assistant
 *   sentence, "I'll review the route, timing, stops", turned a question about
 *   a flight itinerary into an owner-engineer-reviewer chain. It then fed
 *   itself: the chain's own reply said "review", so every following turn in that
 *   conversation matched too. A caller who has already decided there is no chain
 *   is not overruled by a guess about wording. The conversation gate is one such
 *   caller (it pairs the suppression with `replyStyle: 'conversational'`); the
 *   workstream phase runner is another.
 *
 * The batch path keeps its own rule (see evaluateWrfcBatchPolicy): inside a
 * multi-task batch, role-labelled siblings are the model behaviour the collapse
 * exists to correct, so wording still counts there.
 */
import { logger } from '../../utils/logger.js';
import type { AgentInput } from './schema.js';
import {
  askDelegatesToAgent,
  callerSuppressedWrfcChain,
  isRootReviewRoleTemplate,
  rootSpawnIsReadOnlyAsk,
  taskProseReadsAsRootReviewRole,
} from './wrfc-batch-policy.js';

/**
 * What the user's own ask decides about a parentless spawn, before any
 * role/prose normalization:
 * - an ask that forbids writing files ("Do not modify files") outranks a
 *   model-set reviewMode and a review-role template: no chain, whose fix
 *   phase would write; the spawn runs as a plain agent;
 * - an ask that is itself a delegation instruction ("Spawn one reviewer agent
 *   to …") is not the child's task: the child keeps the task the model
 *   delegated (the caller skips the authoritative-scope substitution).
 */
export function routeRootSpawnAsk(input: AgentInput, task: string, template: string): {
  readonly input: AgentInput;
  readonly delegationAsk: boolean;
  readonly routeReason: string | undefined;
  /** Whether the spawn is still rewritten into an owner chain (rootSpawnNeedsWrfcNormalization), never for a read-only ask. */
  readonly rootReviewRoleTask: boolean;
} {
  const readOnlyAsk = rootSpawnIsReadOnlyAsk(input);
  const routed: AgentInput = readOnlyAsk ? { ...input, reviewMode: 'none', dangerously_disable_wrfc: true } : input;
  return {
    input: routed,
    delegationAsk: !input.parentAgentId && askDelegatesToAgent(input.authoritativeTask),
    routeReason: readOnlyAsk ? 'root-read-only-ask' : undefined,
    rootReviewRoleTask: !readOnlyAsk && rootSpawnNeedsWrfcNormalization(routed, task, template),
  };
}

export function rootSpawnNeedsWrfcNormalization(
  input: Pick<AgentInput, 'dangerously_disable_wrfc' | 'reviewMode' | 'replyStyle' | 'parentAgentId'>,
  task: string,
  template: string,
): boolean {
  // A child agent is never a root spawn, so the rewrite never applies to one.
  if (input.parentAgentId) return false;
  if (isRootReviewRoleTemplate(template)) return true;
  if (!taskProseReadsAsRootReviewRole(task)) return false;
  if (!callerSuppressedWrfcChain(input)) return true;
  logger.debug('AgentManager.spawn: keeping the caller\'s no-chain decision over a review/test wording match', {
    template,
    replyStyle: input.replyStyle ?? 'report',
  });
  return false;
}
