/**
 * tools/profile, the agent tool that records what the owner says about themselves.
 *
 * ## Why the tool cannot be told its own authority
 *
 * Every write here goes through the owner-profile write gate, and that gate's
 * first layer asks which surface the instruction came from. If the model
 * supplied that answer, a sentence inside a forwarded email could claim to be
 * the owner and the gate would be decoration.
 *
 * So the authority is BOUND to the tool, not passed to it. The composition root
 * resolves it once per conversational turn from the turn's channel and the
 * owner's settings (personal-capture/authority.ts) and calls `bindCapture` to
 * produce the instance that run sees. The model chooses WHAT to record and
 * never whether it is allowed to.
 *
 * An unbound instance, a local surface, a turn nobody resolved a channel for,
 * keeps the default the composition root gave it, which is the owner's own
 * authority for a surface the owner is sitting at.
 *
 * ## Refusals are spoken, never swallowed
 *
 * Every failure path returns `success: true` with a `stored: false` payload and
 * a plain sentence naming what stopped it. That is deliberate: a tool error
 * tends to be summarised away as "something went wrong", and the standing rule
 * for this subsystem is that nothing unresolved drops silently. The agent is
 * told, in the same structure as a success, exactly what to repeat to the owner.
 */
import type { Tool, ToolResult } from '../../types/tools.js';
import { PROFILE_TOOL_SCHEMA, type ProfileToolInput } from './schema.js';
import type { CaptureAuthorityDecision } from '../../personal-capture/authority.js';
import type { PersonalCaptureHolder } from '../../personal-capture/port.js';
import {
  PROFILE_SECTIONS,
  canonicalProfileSection,
  openTierFieldIds,
  closedTierFieldIds,
  profileFieldById,
} from '../../owner-profile/index.js';

/** A profile tool instance that can be re-bound to one turn's authority. */
export interface ProfileTool extends Tool {
  /** A copy of this tool that writes with `decision`'s authority. Pure; the original is unchanged. */
  bindCapture(decision: CaptureAuthorityDecision): ProfileTool;
}

export interface ProfileToolDeps {
  /** Where the profile store and occasions service arrive, once composed. */
  readonly holder: Pick<PersonalCaptureHolder, 'getPort'>;
  /** Live read of `profile.conversationalCapture`. Absent ⇒ on. */
  readonly captureEnabled?: (() => boolean) | undefined;
  /** The authority an unbound instance writes with. */
  readonly defaultAuthority: CaptureAuthorityDecision;
}

type ToolAnswer = Omit<ToolResult, 'callId'>;

function refused(reason: string, extra: Record<string, unknown> = {}): ToolAnswer {
  return {
    success: true,
    output: JSON.stringify({ stored: false, reason, ...extra }),
  };
}

function stored(payload: Record<string, unknown>): ToolAnswer {
  return { success: true, output: JSON.stringify({ stored: true, ...payload }) };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function createInstance(
  deps: ProfileToolDeps,
  authority: CaptureAuthorityDecision,
): ProfileTool {
  const captureAllowed = (): string | null => {
    if (deps.captureEnabled && !deps.captureEnabled()) {
      return 'Recording to your profile from a conversation is turned off '
        + '(profile.conversationalCapture). Nothing was stored.';
    }
    if (!authority.canCapture) return authority.reason;
    return null;
  };

  return {
    definition: PROFILE_TOOL_SCHEMA,

    bindCapture(decision: CaptureAuthorityDecision): ProfileTool {
      return createInstance(deps, decision);
    },

    async execute(args: Record<string, unknown>): Promise<ToolAnswer> {
      const input = (args ?? {}) as unknown as ProfileToolInput;
      const action = text(input.action);
      if (action.length === 0) {
        return { success: false, error: 'Invalid args: action is required.' };
      }

      const port = deps.holder.getPort();
      if (!port) {
        return refused(
          'The owner profile is not available in this process, so nothing could be recorded. '
          + 'Tell the owner plainly that you could not store it.',
        );
      }

      if (action === 'list') {
        const [dates, plans] = await Promise.all([
          port.occasions.list(),
          Promise.resolve(port.occasions.listPlans()),
        ]);
        return {
          success: true,
          output: JSON.stringify({
            today: dates.today,
            dates: dates.occasions.map((view) => ({
              id: view.occasion.id,
              title: view.occasion.title,
              date: view.occasion.text,
              kind: view.occasion.kind,
              person: view.occasion.person,
              daysUntil: view.daysUntil,
            })),
            plans: plans.plans.map((plan) => ({
              id: plan.id,
              title: plan.title,
              from: plan.from,
              to: plan.to,
              away: plan.away,
              destination: plan.destination,
              details: plan.extras,
            })),
            awayNow: plans.awayNow?.title ?? null,
          }),
        };
      }

      // Acknowledging sits ABOVE the capture gate on purpose. It writes to the
      // machine's own occasions state and never to the owner's profile document, and
      // "stop reminding me about this" is the one instruction that must never
      // be refused because profile capture happens to be off. A person telling
      // the thing to be quiet and being told it cannot comply is the whole
      // complaint in miniature.
      if (action === 'acknowledge_occasion') {
        const occasionId = text(input.occasionId);
        if (occasionId.length === 0) {
          return refused(
            'Which occasion? Call `list` for the ids, then acknowledge the one the owner meant. Nothing '
            + 'was changed.',
          );
        }
        const outcome = await port.occasions.acknowledge({
          occasionId,
          source: 'conversation',
          ...(ISO_DATE.test(text(input.occurrence)) ? { occurrence: text(input.occurrence) } : {}),
        });
        if (!outcome.ok) {
          return refused(outcome.reason ?? 'That occasion was not acknowledged.');
        }
        return stored({
          what: 'acknowledgement',
          id: occasionId,
          savedTo: 'your occasions state',
          // Both halves, every time. Saying only "muted" is how the owner ends up
          // unsure whether the rest of their dates went quiet too, which is
          // exactly what happened the day the whole feature got switched off
          // to stop one reminder.
          tellOwner: outcome.reply,
        });
      }

      // Everything below this line writes.
      const blocked = captureAllowed();
      if (blocked) return refused(blocked);

      const said = text(input.said);
      if (said.length === 0) {
        return refused(
          'I need the owner\'s own words for the record before I can store this. Call this again with '
          + '`said` set to what the owner actually wrote.',
        );
      }

      const writeIdentity = {
        surface: authority.surface,
        said,
        authority: authority.authority,
      } as const;

      if (action === 'record_trip') {
        const title = text(input.title);
        const from = text(input.from);
        const to = text(input.to);
        if (title.length === 0) return refused('A trip needs a name before I can record it.');
        if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
          return refused('I need both ends of the trip as YYYY-MM-DD. Nothing was stored.');
        }
        const details = Array.isArray(input.details)
          ? input.details.map((detail) => text(detail)).filter((detail) => detail.length > 0)
          : [];
        const outcome = await port.occasions.confirmPlan({
          title,
          from,
          to,
          away: input.away === true,
          ...(text(input.destination).length > 0 ? { destination: text(input.destination) } : {}),
          ...(details.length > 0 ? { details } : {}),
          ...writeIdentity,
        });
        if (!outcome.ok) return refused(outcome.reason ?? 'The trip was not recorded.');
        return stored({
          what: 'trip',
          id: outcome.occasionId,
          title,
          from,
          to,
          destination: text(input.destination),
          details,
          savedTo: 'your profile, under Plans',
          disclosure: outcome.disclosure,
          tellOwner:
            `Say you stored ${title}, ${from} to ${to}`
            + `${text(input.destination) ? ` in ${text(input.destination)}` : ''}`
            + `${details.length > 0 ? `, with ${details.length} detail(s)` : ''}`
            + ', in the profile under Plans.',
        });
      }

      if (action === 'record_date') {
        const title = text(input.title);
        const date = text(input.date);
        const kind = text(input.kind);
        if (title.length === 0) return refused('The date needs a name before I can record it.');
        if (date.length === 0) return refused('I need the date itself, MM-DD for a yearly one, YYYY-MM-DD for a single day.');
        if (kind.length === 0) {
          return refused(
            'Ask the owner which kind this is, something to sort a gift for, something to just remember, '
            + 'or neither. Nothing is recorded until the owner says, because that is not something to guess at.',
          );
        }
        const outcome = await port.occasions.confirmOccasion({
          title,
          date,
          kind,
          ...(text(input.person).length > 0 ? { person: text(input.person) } : {}),
          ...(input.self === true ? { self: true } : {}),
          ...(text(input.recurrence).length > 0 ? { recurrence: text(input.recurrence) } : {}),
          ...(typeof input.leadDays === 'number' ? { leadDays: input.leadDays } : {}),
          ...writeIdentity,
        });
        if (!outcome.ok) return refused(outcome.reason ?? 'The date was not recorded.');
        return stored({
          what: 'date',
          id: outcome.occasionId,
          title,
          date,
          kind,
          savedTo: 'your profile, under Important dates',
          disclosure: outcome.disclosure,
          tellOwner: `Say you stored ${title} on ${date} in the profile under Important dates.`,
        });
      }

      if (action === 'set_field') {
        const fieldId = text(input.fieldId);
        const value = text(input.value);
        if (fieldId.length === 0 || value.length === 0) {
          return refused('A profile field needs both `fieldId` and `value`.');
        }
        if (!profileFieldById(fieldId)) {
          return refused(`There is no profile field called "${fieldId}".`, {
            validFieldIds: [...openTierFieldIds(), ...closedTierFieldIds()],
          });
        }
        const outcome = await port.profile.set({ fieldId, value, ...writeIdentity });
        if (!outcome.ok) return refused(outcome.reason ?? 'The field was not recorded.');
        return stored({
          what: 'field',
          fieldId,
          savedTo: 'your profile',
          disclosure: outcome.disclosure,
          tellOwner: `Say you saved the owner's ${fieldId} to the profile.`,
        });
      }

      if (action === 'note') {
        const body = text(input.text);
        const section = canonicalProfileSection(text(input.section)) ?? '';
        if (body.length === 0) return refused('A note needs its text.');
        if (section.length === 0) {
          return refused(`There is no profile section called "${text(input.section)}".`, {
            validSections: PROFILE_SECTIONS,
          });
        }
        const outcome = await port.profile.append({ section, text: body, ...writeIdentity });
        if (!outcome.ok) return refused(outcome.reason ?? 'The note was not recorded.');
        return stored({
          what: 'note',
          section,
          savedTo: `your profile, under ${section}`,
          disclosure: outcome.disclosure,
          tellOwner: `Say you noted it in the profile under ${section}.`,
        });
      }

      return { success: false, error: `Unknown action: '${action}'.` };
    },
  };
}

export function createProfileTool(deps: ProfileToolDeps): ProfileTool {
  return createInstance(deps, deps.defaultAuthority);
}

export { PROFILE_TOOL_SCHEMA } from './schema.js';
export type { ProfileToolInput } from './schema.js';
