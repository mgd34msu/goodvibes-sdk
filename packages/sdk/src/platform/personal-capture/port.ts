/**
 * personal-capture/port.ts
 *
 * The narrow surface the capture tool needs, and the holder that lets a
 * composition root hand it over after the tool has already been registered.
 *
 * The tool is registered when the agent tool registry is built; the owner
 * profile store and the occasions service are built later, inside the gateway
 * verb registrar. Rather than reorder either composition, both orders are
 * load-bearing for other reasons, the holder is created first and filled when
 * the real objects exist. Same pattern as ContextAccountingHolder, for the same
 * reason. A tool call that lands before the fill gets a plain "not wired up
 * here" refusal rather than a crash.
 */
import type { OccasionsService } from '../occasions/service.js';
import type { OwnerProfileStore } from '../owner-profile/index.js';

/**
 * The occasions operations capture needs: record a dated thing, record a plan,
 * read both back, and record that the owner has one in hand.
 *
 * `acknowledge` belongs here rather than only on the control plane because of
 * where the answer to a reminder actually arrives. The nudge is pushed to
 * Telegram and to the agent's conversation; the reply to it is a sentence the
 * owner types there. Before this, the only thing that could write an
 * acknowledgement was a CLI/webui verb, so every reply they ever gave to a
 * nudge landed in a conversation and nowhere else, and the sweep, seeing no
 * answer, kept going.
 */
export type CaptureOccasionsAccess = Pick<
  OccasionsService,
  'confirmOccasion' | 'confirmPlan' | 'list' | 'listPlans' | 'acknowledge'
>;

/** The profile operations capture needs: set a declared field, append a prose fact. */
export type CaptureProfileAccess = Pick<OwnerProfileStore, 'set' | 'append' | 'get' | 'status'>;

export interface PersonalCapturePort {
  readonly occasions: CaptureOccasionsAccess;
  readonly profile: CaptureProfileAccess;
}

/**
 * A settable reference to the port.
 *
 * `getPort()` returns null until the composition root fills it, which is a
 * state the tool reports honestly rather than one it hides.
 */
export class PersonalCaptureHolder {
  private port: PersonalCapturePort | null = null;

  setPort(port: PersonalCapturePort | null): void {
    this.port = port;
  }

  getPort(): PersonalCapturePort | null {
    return this.port;
  }
}
