/**
 * personal-information-capture.test.ts
 *
 * The owner told the assistant over Telegram that they were flying Dallas to
 * Picayune on the Thursday to see their parents, and pasted the whole itinerary.
 * Nothing was written anywhere. These tests pin each of the four reasons it
 * could not have been, so none of them can come back quietly.
 */
import { describe, it, expect } from 'bun:test';
import {
  CONVERSATIONAL_TURN_TOOLS,
  buildConversationalTurnContext,
  conversationalTurnSpawnOptions,
  parseOwnerChannelList,
  resolveCaptureAuthority,
  PersonalCaptureHolder,
} from '../packages/sdk/src/platform/personal-capture/index.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../packages/sdk/src/platform/control-plane/session-intents.js';
import { proposePlan, confirmPlan } from '../packages/sdk/src/platform/occasions/capture.js';
import { normalizePlanDetail, parsePlanLine } from '../packages/sdk/src/platform/occasions/grammar.js';
import { createProfileTool } from '../packages/sdk/src/platform/tools/profile/index.js';

/** The itinerary as the owner actually pasted it. */
const ITINERARY_DETAILS = [
  'confirmation B79YKY',
  'flight 995 DAL 07:55 to MSY 09:20 on Thu Aug 06',
  'flight 3175 MSY 15:40 to DAL 17:10 on Sun Aug 09',
  'travellers Avery Chen and Natalie Sons',
  'to see my parents',
];

function ownerDirect() {
  return resolveCaptureAuthority({ channel: undefined, ownerChannels: '', nudgeChannels: '' });
}

describe('what a conversational turn is spawned with', () => {
  it('the old routing builder alone hands the turn no tools at all', () => {
    // The defect, stated as a fact about the code that produced it: with
    // restrictTools true and no tool list, AgentManager reads "only these" over
    // an empty set and the run gets an empty registry.
    const routingOnly = buildSharedSessionAgentSpawnRoutingInput(undefined, { restrictTools: true });
    expect(routingOnly).toEqual({ restrictTools: true });
    expect('tools' in routingOnly).toBe(false);
  });

  it('names the tools a channel turn needs, including the capture tool', () => {
    const options = conversationalTurnSpawnOptions({ sessionId: 's1', surfaceKind: 'telegram' });
    expect(options.restrictTools).toBe(true);
    expect(options.tools.length).toBeGreaterThan(0);
    expect(options.tools).toContain('profile');
    expect(CONVERSATIONAL_TURN_TOOLS).toContain('profile');
  });

  it('gives a conversational turn no way to start work on the tree', () => {
    // A channel follow-up gets an answer, not a work chain. Whatever else this
    // list grows, it must not grow these.
    for (const forbidden of ['write', 'edit', 'exec']) {
      expect(CONVERSATIONAL_TURN_TOOLS).not.toContain(forbidden);
    }
  });

  it('tells the turn that recording is part of answering, and to say what it stored', () => {
    const context = buildConversationalTurnContext({ sessionId: 's1', surfaceKind: 'telegram' });
    expect(context).toContain('shared-session:s1');
    expect(context.toLowerCase()).toContain('part of answering');
    expect(context).toContain('record_trip');
    expect(context.toLowerCase()).toContain('confirmation number');
    // Nothing unresolved drops silently.
    expect(context.toLowerCase()).toContain('if a capture does not complete');
  });

  it('tells the turn to infer what the thing means and to use it, with work still opt-in', () => {
    // Owner ruling 2026-08-02: "if i give the agent something like a plane
    // itinerary, i expect it to know what to do with it, where to save it,
    // how to use it, the things to infer from it."
    const context = buildConversationalTurnContext({ sessionId: 's1', surfaceKind: 'telegram' });
    expect(context).toContain('Capture what the message implies, not only what it states.');
    // Inference has named examples, not vibes: the away-span and the people.
    expect(context.toLowerCase()).toContain('the owner is');
    expect(context.toLowerCase()).toContain("people in the owner's life");
    // Use follows capture: the stored thing shapes the answer and the offers.
    expect(context).toContain('Then use it.');
    expect(context.toLowerCase()).toContain('reminder before departure');
    // The conversation-first boundary survives the ambition: anything beyond
    // the conversation is proposed, never started.
    expect(context.toLowerCase()).toContain("waits for the owner's yes");
  });

  it('says so in the context when this turn may not record', () => {
    const context = buildConversationalTurnContext({
      sessionId: 's1',
      surfaceKind: 'sms',
      capture: { canCapture: false, reason: 'sms is not listed.' },
    });
    expect(context).toContain('not available on this turn');
    expect(context).toContain('sms is not listed.');
  });
});

describe('which turns carry the owner\'s own authority', () => {
  it('a surface he is sitting at does', () => {
    const decision = ownerDirect();
    expect(decision.authority).toBe('owner-direct');
    expect(decision.canCapture).toBe(true);
    expect(decision.source).toBe('local-surface');
  });

  it('telegram does, on the shipped defaults, with nothing configured', () => {
    // occasions.nudgeChannel ships as 'telegram', the channel already trusted
    // to carry his private reminders outbound. This is the reported case.
    const decision = resolveCaptureAuthority({
      channel: { surfaceKind: 'telegram' },
      ownerChannels: '',
      nudgeChannels: 'telegram',
    });
    expect(decision.canCapture).toBe(true);
    expect(decision.authority).toBe('owner-direct');
    expect(decision.source).toBe('occasions.nudgeChannel');
  });

  it('a channel he never named does not, and the refusal names the setting', () => {
    const decision = resolveCaptureAuthority({
      channel: { surfaceKind: 'sms' },
      ownerChannels: '',
      nudgeChannels: 'telegram',
    });
    expect(decision.canCapture).toBe(false);
    expect(decision.authority).toBe('channel-message');
    expect(decision.reason).toContain('profile.ownerChannels');
    expect(decision.reason).toContain('sms');
  });

  it('an explicit list wins over the inherited one, in both directions', () => {
    const allowed = resolveCaptureAuthority({
      channel: { surfaceKind: 'slack' },
      ownerChannels: 'slack',
      nudgeChannels: 'telegram',
    });
    expect(allowed.canCapture).toBe(true);
    expect(allowed.source).toBe('profile.ownerChannels');

    // Telegram is the nudge channel, but the explicit list did not name it.
    const refused = resolveCaptureAuthority({
      channel: { surfaceKind: 'telegram' },
      ownerChannels: 'slack',
      nudgeChannels: 'telegram',
    });
    expect(refused.canCapture).toBe(false);
  });

  it('refuses a routed turn whose surface did not come through, rather than assuming it is him', () => {
    // The wrong way to fail here is to read a channel turn with missing
    // metadata as the owner typing at his own keyboard.
    const decision = resolveCaptureAuthority({
      channel: { routed: true },
      ownerChannels: '',
      nudgeChannels: 'telegram',
    });
    expect(decision.canCapture).toBe(false);
    expect(decision.authority).toBe('channel-message');
    expect(decision.reason).toContain('did not say which one');
  });

  it('a routed turn with no surface gets no tools-level capture through the spawn contract either', () => {
    const options = conversationalTurnSpawnOptions({ sessionId: 's1', routeId: 'route-7' });
    expect(options.captureAuthority.canCapture).toBe(false);
    expect(options.context).toContain('not available on this turn');
  });

  it('matches an address when one is pinned, and any address when one is not', () => {
    expect(parseOwnerChannelList('telegram:12345, slack')).toEqual([
      { surfaceKind: 'telegram', address: '12345' },
      { surfaceKind: 'slack', address: '' },
    ]);
    const pinned = { ownerChannels: 'telegram:12345', nudgeChannels: '' };
    expect(resolveCaptureAuthority({ channel: { surfaceKind: 'telegram', address: '12345' }, ...pinned }).canCapture).toBe(true);
    expect(resolveCaptureAuthority({ channel: { surfaceKind: 'telegram', address: '99999' }, ...pinned }).canCapture).toBe(false);
    // Unpinned matches any chat on that surface.
    expect(resolveCaptureAuthority({
      channel: { surfaceKind: 'telegram', address: '99999' },
      ownerChannels: 'telegram',
      nudgeChannels: '',
    }).canCapture).toBe(true);
  });
});

describe('a trip keeps the details he pasted', () => {
  it('carries every itinerary detail onto the line and reads them all back', () => {
    const proposal = proposePlan({
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      destination: 'Picayune MS',
      details: ITINERARY_DETAILS,
    });
    expect(proposal.ok).toBe(true);
    const reread = parsePlanLine(0, proposal.line);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error('unreachable');
    expect(reread.plan.from).toBe('2026-08-06');
    expect(reread.plan.to).toBe('2026-08-09');
    expect(reread.plan.away).toBe(true);
    expect(reread.plan.destination).toBe('Picayune MS');
    expect(reread.plan.extras).toEqual(ITINERARY_DETAILS);
    // The confirmation number specifically, it is the thing a grep for the
    // trip found nowhere on disk.
    expect(proposal.line).toContain('B79YKY');
  });

  it('a detail carrying a separator does not split into two details', () => {
    const proposal = proposePlan({
      title: 'Trip',
      from: '2026-08-06',
      to: '2026-08-09',
      details: ['seats 12A | 12B'],
    });
    expect(proposal.ok).toBe(true);
    const reread = parsePlanLine(0, proposal.line);
    if (!reread.ok) throw new Error('unreachable');
    expect(reread.plan.extras).toHaveLength(1);
    expect(reread.plan.extras[0]).toContain('12A');
    expect(reread.plan.extras[0]).toContain('12B');
  });

  it('a detail that reads like structure does not become structure', () => {
    // "in Dallas" would otherwise be parsed as the destination, and "away" as
    // the away flag, silently changing the record.
    expect(normalizePlanDetail('in Dallas')).toBe('note in Dallas');
    expect(normalizePlanDetail('away')).toBe('note away');
    expect(normalizePlanDetail('2026-01-01..2026-01-02')).toBe('note 2026-01-01..2026-01-02');
    const proposal = proposePlan({
      title: 'Trip',
      from: '2026-08-06',
      to: '2026-08-09',
      destination: 'Picayune MS',
      details: ['in Dallas', 'away'],
    });
    const reread = parsePlanLine(0, proposal.line);
    if (!reread.ok) throw new Error('unreachable');
    expect(reread.plan.destination).toBe('Picayune MS');
    expect(reread.plan.away).toBe(false);
    expect(reread.plan.extras).toEqual(['note in Dallas', 'note away']);
  });

  it('drops an empty detail rather than writing a bare separator', () => {
    const proposal = proposePlan({
      title: 'Trip',
      from: '2026-08-06',
      to: '2026-08-09',
      details: ['   ', 'confirmation B79YKY'],
    });
    const reread = parsePlanLine(0, proposal.line);
    if (!reread.ok) throw new Error('unreachable');
    expect(reread.plan.extras).toEqual(['confirmation B79YKY']);
  });

  it('writes the details through to the profile line', async () => {
    const written: { section: string; text: string; said: string; authority: string }[] = [];
    const writer = {
      append: async (input: { section: string; text: string; said: string; authority: string }) => {
        written.push(input);
        return { ok: true, reason: null, disclosure: 'Saved to your profile under Plans.' };
      },
    };
    const outcome = await confirmPlan(writer as never, {
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      destination: 'Picayune MS',
      details: ITINERARY_DETAILS,
      surface: 'agent',
      said: 'I\'m traveling from Dallas to Picayune MS on Thursday to see my parents',
      authority: 'owner-direct',
    });
    expect(outcome.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toContain('B79YKY');
    expect(written[0]!.text).toContain('Natalie Sons');
    expect(written[0]!.authority).toBe('owner-direct');
  });
});

describe('the profile capture tool', () => {
  function fakePort() {
    const plans: unknown[] = [];
    return {
      plans,
      port: {
        occasions: {
          confirmPlan: async (input: Record<string, unknown>) => {
            plans.push(input);
            return { ok: true, reason: null, occasionId: 'trip-to-picayune', disclosure: 'Saved.', droppedRecords: 0 };
          },
          confirmOccasion: async () => ({ ok: true, reason: null, occasionId: 'd', disclosure: 'Saved.', droppedRecords: 0 }),
          list: async () => ({ today: '2026-08-02', timezone: 'UTC', occasions: [], unparsed: [], conflicts: [] }),
          listPlans: () => ({ today: '2026-08-02', plans: [], unparsed: [], awayNow: null }),
        },
        profile: {
          set: async () => ({ ok: true, reason: null, disclosure: 'Saved.' }),
          append: async () => ({ ok: true, reason: null, disclosure: 'Saved.' }),
          get: () => null,
          status: () => ({}),
        },
      },
    };
  }

  function toolWith(port: unknown, authority = ownerDirect()) {
    return createProfileTool({
      holder: { getPort: () => port as never },
      defaultAuthority: authority,
    });
  }

  it('records the pasted itinerary and says concretely what it stored', async () => {
    const { plans, port } = fakePort();
    const result = await toolWith(port).execute({
      action: 'record_trip',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      destination: 'Picayune MS',
      details: ITINERARY_DETAILS,
      said: 'I\'m traveling from Dallas to Picayune MS on Thursday to see my parents',
    });
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output as string);
    expect(payload.stored).toBe(true);
    expect(payload.from).toBe('2026-08-06');
    expect(payload.to).toBe('2026-08-09');
    expect(payload.savedTo).toContain('Plans');
    expect(payload.tellOwner).toContain('2026-08-06');
    expect(plans).toHaveLength(1);
    expect((plans[0] as { details: string[] }).details).toEqual(ITINERARY_DETAILS);
  });

  it('refuses plainly, not silently, when the turn may not record', async () => {
    const { plans, port } = fakePort();
    const refusedAuthority = resolveCaptureAuthority({
      channel: { surfaceKind: 'sms' },
      ownerChannels: '',
      nudgeChannels: 'telegram',
    });
    const result = await toolWith(port, refusedAuthority).execute({
      action: 'record_trip',
      title: 'Trip',
      from: '2026-08-06',
      to: '2026-08-09',
      said: 'flying Thursday',
    });
    const payload = JSON.parse(result.output as string);
    expect(payload.stored).toBe(false);
    expect(payload.reason).toContain('profile.ownerChannels');
    expect(plans).toHaveLength(0);
  });

  it('binds a turn\'s authority without mutating the shared instance', async () => {
    const { plans, port } = fakePort();
    const base = toolWith(port);
    const refused = base.bindCapture(resolveCaptureAuthority({
      channel: { surfaceKind: 'sms' }, ownerChannels: '', nudgeChannels: '',
    }));
    const args = { action: 'record_trip', title: 'T', from: '2026-08-06', to: '2026-08-09', said: 'x' };
    expect(JSON.parse((await refused.execute(args)).output as string).stored).toBe(false);
    // The original is untouched, binding returns a copy.
    expect(JSON.parse((await base.execute(args)).output as string).stored).toBe(true);
    expect(plans).toHaveLength(1);
  });

  it('will not record without his own words for the provenance', async () => {
    const { plans, port } = fakePort();
    const result = await toolWith(port).execute({
      action: 'record_trip', title: 'T', from: '2026-08-06', to: '2026-08-09',
    });
    const payload = JSON.parse(result.output as string);
    expect(payload.stored).toBe(false);
    expect(payload.reason).toContain('said');
    expect(plans).toHaveLength(0);
  });

  it('never guesses whether a date is a birthday or a death anniversary', async () => {
    const { port } = fakePort();
    const result = await toolWith(port).execute({
      action: 'record_date', title: 'Dad', date: '03-14', said: 'dad\'s date is March 14',
    });
    const payload = JSON.parse(result.output as string);
    expect(payload.stored).toBe(false);
    expect(payload.reason.toLowerCase()).toContain('kind');
  });

  it('says it cannot store anything when the profile is not wired up here', async () => {
    const holder = new PersonalCaptureHolder();
    const tool = createProfileTool({ holder, defaultAuthority: ownerDirect() });
    const result = await tool.execute({
      action: 'record_trip', title: 'T', from: '2026-08-06', to: '2026-08-09', said: 'x',
    });
    // Reported as a spoken refusal rather than a tool error, so it cannot be
    // summarised away as a friendly acknowledgement.
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output as string);
    expect(payload.stored).toBe(false);
    expect(payload.reason).toContain('could not');
  });

  it('stops writing when conversational capture is turned off, and says why', async () => {
    const { plans, port } = fakePort();
    const tool = createProfileTool({
      holder: { getPort: () => port as never },
      captureEnabled: () => false,
      defaultAuthority: ownerDirect(),
    });
    const payload = JSON.parse((await tool.execute({
      action: 'record_trip', title: 'T', from: '2026-08-06', to: '2026-08-09', said: 'x',
    })).output as string);
    expect(payload.stored).toBe(false);
    expect(payload.reason).toContain('profile.conversationalCapture');
    expect(plans).toHaveLength(0);
    // Reads still work with writing off.
    expect((await tool.execute({ action: 'list' })).success).toBe(true);
  });
});
