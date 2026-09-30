import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { RuntimeEventBus, AgentEvent, WorkflowEvent } from '../runtime/events/index.js';
import { SlackIntegration } from './slack.js';
import { DiscordIntegration } from './discord.js';
import { DeliveryQueue } from './delivery.js';
import type { DeliveryQueueConfig, IntegrationQueueStatus } from './delivery.js';
import { snapshotQueueStatus } from './delivery.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import {
  WorkNameMemory,
  agentCompletedText,
  workstreamFailedText,
  workstreamPassedText,
} from './work-notification-text.js';

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Notifier, unified notification dispatcher.
 *
 * Reads configuration from environment variables:
 *   SLACK_WEBHOOK_URL, SLACK_BOT_TOKEN
 *   DISCORD_WEBHOOK_URL, DISCORD_BOT_TOKEN
 *
 * Attach to the RuntimeEventBus to automatically post notifications for key events.
 *
 * Text (owner ruling 2026-09-29, work-notification-text.ts, the same words the
 * webhook channel uses): an agent or workstream notice names its task, taken
 * from the opening event. When behavior.notificationsMetadataOnly is on
 * (default off; the `metadataOnly` reader is called at send time, so a change
 * applies without a restart) it carries ids and outcomes only, never the task,
 * a failure reason or the agent's output.
 */
export class Notifier {
  private slack?: SlackIntegration | undefined;
  private discord?: DiscordIntegration | undefined;
  private unsubscribers: Array<() => void> = [];
  private readonly _queue: DeliveryQueue;
  /** behavior.notificationsMetadataOnly, read at send time. Absent means off. */
  private metadataOnly: () => boolean;
  /** Task text per agent id / workstream id, from the opening event; dropped at the terminal one. */
  private readonly names = new WorkNameMemory();

  constructor(options?: {
    slack?: SlackIntegration | undefined;
    discord?: DiscordIntegration | undefined;
    delivery?: Partial<DeliveryQueueConfig> | undefined;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
    /** Reader for behavior.notificationsMetadataOnly, called at send time. Absent means off. */
    metadataOnly?: (() => boolean) | undefined;
  }) {
    this.slack = options?.slack;
    this.discord = options?.discord;
    this.metadataOnly = options?.metadataOnly ?? (() => false);
    this._queue = new DeliveryQueue({
      ...(options?.delivery ?? {}),
      featureFlags: options?.featureFlags,
    });
  }

  /**
   * Create a Notifier pre-wired from configured services and environment variables.
   */
  static async fromConfig(
    serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>,
    options: {
      featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
      /** Reader for behavior.notificationsMetadataOnly, called at send time. */
      metadataOnly?: (() => boolean) | undefined;
    } = {},
  ): Promise<Notifier> {
    const [
      slackWebhookFromService,
      slackTokenFromService,
      discordWebhookFromService,
      discordTokenFromService,
    ] = await Promise.all([
      serviceRegistry.resolveSecret('slack', 'webhookUrl'),
      serviceRegistry.resolveSecret('slack', 'primary'),
      serviceRegistry.resolveSecret('discord', 'webhookUrl'),
      serviceRegistry.resolveSecret('discord', 'primary'),
    ]);

    const slackWebhook = slackWebhookFromService ?? process.env.SLACK_WEBHOOK_URL;
    const slackToken = slackTokenFromService ?? process.env.SLACK_BOT_TOKEN;
    const discordWebhook = discordWebhookFromService ?? process.env.DISCORD_WEBHOOK_URL;
    const discordToken = discordTokenFromService ?? process.env.DISCORD_BOT_TOKEN;

    const slack =
      slackWebhook || slackToken
        ? new SlackIntegration(slackWebhook, slackToken)
        : undefined;

    const discord =
      discordWebhook || discordToken
        ? new DiscordIntegration(discordWebhook, discordToken)
        : undefined;

    return new Notifier({ slack, discord, featureFlags: options.featureFlags, metadataOnly: options.metadataOnly });
  }

  /** Replace the behavior.notificationsMetadataOnly reader (hosts that build the notifier before config is ready). */
  setMetadataOnlyReader(reader: () => boolean): void {
    this.metadataOnly = reader;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send a notification to all configured channels.
   *
   * @param event  - Human-readable event name (used as message text)
   * @param data   - Arbitrary key/value payload for formatting
   */
  async notify(event: string, data: Record<string, unknown>): Promise<void> {
    await this.deliver(event, this.formatText(event, data));
  }

  /** Post already-worded text to every configured channel through the delivery queue. */
  private async deliver(event: string, text: string): Promise<void> {
    if (this.slack) {
      const slack = this.slack;
      await this._queue.enqueue('slack', event, text, () => slack.postWebhook(text));
    }

    if (this.discord) {
      const discord = this.discord;
      await this._queue.enqueue('discord', event, text, () => discord.postWebhook(text));
    }
  }

  /**
   * Get delivery queue status snapshots for all active channels.
   * Used by integration diagnostics to surface queue and DLQ state.
   */
  getQueueStatus(): IntegrationQueueStatus[] {
    const sloEnforced = this._queue.sloEnforced;
    const statuses: IntegrationQueueStatus[] = [];
    if (this.slack) {
      statuses.push(snapshotQueueStatus('slack', this._queue, sloEnforced));
    }
    if (this.discord) {
      statuses.push(snapshotQueueStatus('discord', this._queue, sloEnforced));
    }
    return statuses;
  }

  /**
   * Replay all dead-letter entries to their respective channels.
   * Re-attempts delivery for each DLQ entry; results are returned per-entry.
   */
  async replayDeadLetters(): Promise<Array<{ id: string; outcome: import('./delivery.js').DeliveryOutcome }>> {
    return this._queue.replay(async (dlqEntry) => {
      const text = dlqEntry.payload;
      if (dlqEntry.channel === 'slack' && this.slack) {
        await this.slack.postWebhook(text);
      } else if (dlqEntry.channel === 'discord' && this.discord) {
        await this.discord.postWebhook(text);
      } else {
        throw new Error(`No active integration for channel: ${dlqEntry.channel}`);
      }
    });
  }

  /** Dispose the delivery queue (cancel pending timers). Call on shutdown. */
  dispose(): void {
    this._queue.dispose();
  }

  attachToRuntimeBus(bus: RuntimeEventBus): void {
    this.detach();

    // The opening events carry the task text; the terminal ones carry the id
    // alone, so the names are remembered here for the length of the work.
    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>('AGENT_SPAWNING', ({ payload }) => {
        this.names.rememberAgent(payload.agentId, payload.task);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', ({ payload }) => {
        this.names.rememberWorkstream(payload.chainId, payload.task);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
        this.sendRuntimeNotification('AGENT_COMPLETED', agentCompletedText(payload.agentId, this.names.takeAgent(payload.agentId), this.metadataOnly));
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
        this.sendRuntimeNotification('WORKFLOW_CHAIN_PASSED', workstreamPassedText(this.names.takeWorkstream(payload.chainId), this.metadataOnly));
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
        this.sendRuntimeNotification('WORKFLOW_CHAIN_FAILED', workstreamFailedText(this.names.takeWorkstream(payload.chainId), payload.reason, this.metadataOnly));
      }),
    );

    logger.info('Notifier: attached to RuntimeEventBus');
  }

  /** Remove all notification subscriptions. */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private sendRuntimeNotification(event: string, text: string): void {
    void this.deliver(event, text).catch((error: unknown) => {
      logger.warn(`[notifier] ${event} notification failed`, { error: summarizeError(error) });
    });
  }

  /**
   * Text for the public notify(event, data) API. The three runtime events
   * take the same words as the bus handlers above, including the privacy
   * setting; `data.task` names the work.
   */
  private formatText(event: string, data: Record<string, unknown>): string {
    switch (event) {
      case 'AGENT_COMPLETED':
        return agentCompletedText(String(data.agentId ?? ''), stringOrNull(data.task), this.metadataOnly);
      case 'WORKFLOW_CHAIN_PASSED':
        return workstreamPassedText(stringOrNull(data.task), this.metadataOnly);
      case 'WORKFLOW_CHAIN_FAILED':
        return workstreamFailedText(stringOrNull(data.task), typeof data.reason === 'string' ? data.reason : 'unknown reason', this.metadataOnly);
      default: {
        const extras = Object.entries(data)
          .filter(([k]) => k !== 'event')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ');
        return extras ? `${event}: ${extras}` : event;
      }
    }
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
