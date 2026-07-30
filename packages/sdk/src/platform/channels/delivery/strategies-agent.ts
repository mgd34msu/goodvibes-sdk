/**
 * strategies-agent.ts — the agent's own conversation as a push destination.
 *
 * ## Why this is a seam rather than a transport
 *
 * Every other delivery strategy in this directory can reach its surface on its
 * own: a bot token and an HTTP call, a webhook URL, a bridge. The agent cannot
 * be reached that way. Landing a message in an agent conversation means taking a
 * turn inside the agent product, and the daemon has no way to do that from
 * outside the product's own process.
 *
 * So the split is: the SDK owns the DESTINATION and the CONTRACT — `agent` is a
 * delivery surface kind, this strategy claims targets addressed to it, and
 * {@link AgentConversationMessage} is the shape it hands over — and the agent
 * product owns the CALLABLE that does the landing, registered through
 * {@link AgentDeliveryRegistry}. That is the same division channel plugins
 * already use for a surface the SDK does not implement itself; the difference is
 * only that what gets registered here is one sender rather than a whole
 * strategy, because the addressing, the target parsing and the failure reporting
 * are the same for every surface and belong in one place.
 *
 * ## The defect this closes
 *
 * The owner's ruling on occasion nudges was Telegram **and** the agent
 * (docs/occasions.md §4.2). The first cut shipped the agent as pull-only,
 * because `agent` was not in the delivery surface vocabulary at all: no strategy
 * could claim the target, so `occasions.nudgeChannel = 'agent'` resolved to a
 * destination the router then refused as unroutable. Setting it configured
 * nothing, and said nothing about configuring nothing.
 */
import type { ArtifactReference } from '../../artifacts/index.js';
import { firstNonEmpty, resolveChannelDeliverySurfaceKind, success, titleFromBody } from './shared.js';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  ChannelDeliveryStrategy,
} from './types.js';

/** The strategy id, so a composition can find or replace this one by name. */
export const AGENT_DELIVERY_STRATEGY_ID = 'channel-delivery:agent';

/**
 * One message the daemon is asking the agent to raise in its conversation.
 *
 * Deliberately not a `ChannelDeliveryRequest`: the sender lives in another
 * product, and handing it the router's own request type would make every field
 * the router ever adds part of a cross-repo contract. This is the subset that
 * means something to a conversation.
 */
export interface AgentConversationMessage {
  /** A short subject line. Never empty — derived from the body when absent. */
  readonly title: string;
  /** The text to raise. Already composed; the agent renders, it does not rewrite. */
  readonly body: string;
  /** The conversation to land it in, when the target or binding named one. */
  readonly conversationId?: string | undefined;
  /** What produced this, for the agent's own attribution. */
  readonly jobId: string;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly attachments?: readonly ArtifactReference[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * What the agent product supplies: the one call that lands a message in its
 * conversation.
 *
 * Returning an id is optional and means whatever the product's own transcript
 * calls the message. Throwing is the honest answer when it could not be landed —
 * the router logs the surface, the strategy and the reason, and the caller is
 * told rather than left with a message that went nowhere.
 */
export interface AgentConversationSender {
  /** Names the implementation in logs and in a takeover refusal. */
  readonly id: string;
  send(message: AgentConversationMessage): Promise<string | undefined>;
}

/**
 * Where the agent product plugs its sender in.
 *
 * One per router, owned by the router, so a composition root does not have to
 * order "construct the router" and "start the agent" — the destination exists
 * from the moment the router does, and a push that arrives before the product
 * has registered fails by NAME ("no sender registered") rather than by looking
 * like an unknown surface.
 */
export class AgentDeliveryRegistry {
  private sender: AgentConversationSender | null = null;

  /**
   * Register the sender, and hand back the undo.
   *
   * A second registration is refused rather than silently winning, because two
   * agent conversations both claiming to be THE conversation is how a nudge
   * lands in the one he is not reading. `replace` is the explicit takeover for a
   * product that genuinely swaps its sender at runtime.
   */
  register(
    sender: AgentConversationSender,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    if (this.sender !== null && this.sender !== sender && options.replace !== true) {
      throw new Error(
        `An agent conversation sender is already registered (${this.sender.id}). `
        + 'Pass { replace: true } to take the destination over.',
      );
    }
    this.sender = sender;
    return (): void => {
      if (this.sender === sender) this.sender = null;
    };
  }

  /** The registered sender, or `null` while the agent product has not wired one. */
  current(): AgentConversationSender | null {
    return this.sender;
  }

  /** Whether a push to the agent can land right now. */
  get registered(): boolean {
    return this.sender !== null;
  }
}

/**
 * The strategy that turns an `agent` delivery target into one sender call.
 *
 * It holds the registry rather than the sender, so registering after the router
 * was built works — which is the ordinary case, since the router is part of the
 * runtime graph the agent product is started from.
 */
export function createAgentDeliveryStrategy(
  registry: Pick<AgentDeliveryRegistry, 'current'>,
): ChannelDeliveryStrategy {
  return {
    id: AGENT_DELIVERY_STRATEGY_ID,
    canHandle(request: ChannelDeliveryRequest): boolean {
      return resolveChannelDeliverySurfaceKind(request.target) === 'agent';
    },
    async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
      const sender = registry.current();
      if (sender === null) {
        // Named, not generic. "Unsupported target" would send whoever reads it
        // looking for a missing surface kind, when what is missing is the
        // product's own registration.
        throw new Error(
          'No agent conversation sender is registered, so a message addressed to the agent has '
          + 'nowhere to land. The agent product registers one through '
          + 'ChannelDeliveryRouter.agentDelivery.register().',
        );
      }
      // The same resolution chain every other strategy uses: what the caller
      // addressed, then what the route binding knows, then nothing — which means
      // the product's default conversation.
      const conversationId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
      );
      const responseId = await sender.send({
        title: request.title.trim().length > 0 ? request.title : titleFromBody(request.body),
        body: request.body,
        ...(conversationId === undefined ? {} : { conversationId }),
        jobId: request.jobId,
        runId: request.runId,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      });
      return success(responseId ?? conversationId);
    },
  };
}
