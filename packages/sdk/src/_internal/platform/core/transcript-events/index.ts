import { classifyTranscriptMessages } from './classify.js';
import { groupTranscriptEvents } from './grouping.js';
import type { ConversationMessageSnapshot } from '../conversation.js';

export { classifyTranscriptMessages } from './classify.js';
export { groupTranscriptEvents } from './grouping.js';
export type { TranscriptEvent, TranscriptEventKind } from './types.js';
export type { TranscriptEventGroup } from './grouping.js';

export function buildTranscriptEventIndex(messages: readonly ConversationMessageSnapshot[]) {
  const events = classifyTranscriptMessages(messages);
  const groups = groupTranscriptEvents(events);
  return { events, groups };
}
