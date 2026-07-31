/**
 * method-catalog-rewind.ts
 *
 * The rewind.plan + rewind.apply descriptors — the unified message-anchored
 * rewind that restores files (nearest workspace checkpoint), conversation
 * (truncate session state to the anchor), or both, reusing the platform's
 * existing history stores. rewind.plan is a read-only dry-run preview that
 * mints a single-use confirm token; rewind.apply is destructive and requires
 * that token (or confirm:true), following the checkpoints.restore confirm
 * idiom. ws-only invoke verbs (no REST binding). Handlers: routes/rewind.ts.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  REWIND_PLAN_INPUT_SCHEMA,
  REWIND_PLAN_OUTPUT_SCHEMA,
  REWIND_APPLY_INPUT_SCHEMA,
  REWIND_APPLY_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_REGISTER_INPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_REGISTER_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_RELEASE_INPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_RELEASE_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_HOSTS_LIST_INPUT_SCHEMA,
  REWIND_CONVERSATION_HOSTS_LIST_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_ANSWER_INPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_ANSWER_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_TAKE_INPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_TAKE_OUTPUT_SCHEMA,
} from './operator-contract-schemas-rewind.js';

export const builtinGatewayRewindMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'rewind.plan',
    title: 'Preview a Unified Rewind',
    description:
      'Dry-run preview of a unified rewind to a session turn anchor: exactly what restoring files (the nearest workspace checkpoint), conversation (truncating session state to the anchor), or both would change, and a short-lived single-use confirm token authorizing the matching rewind.apply. Read-only — nothing is changed. A part with no store wired on this runtime is reported unavailable in a warning, never faked.',
    category: 'rewind',
    scopes: ['read:checkpoints'],
    transport: ['ws'],
    inputSchema: REWIND_PLAN_INPUT_SCHEMA,
    outputSchema: REWIND_PLAN_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.apply',
    title: 'Apply a Unified Rewind',
    description:
      'Apply a unified rewind to a session turn anchor, restoring files and/or conversation. DESTRUCTIVE: requires confirmation — either the confirmToken minted by rewind.plan (single-use, ~2 min) or confirm:true. Called without either, it returns a non-error refusal (refused:true) naming rewind.plan, never a silent no-op; a bad token is a 400. Every apply records an undo point (the workspace restore takes a pre-restore safety checkpoint; the conversation store captures its pre-rewind snapshot) so the rewind is itself reversible, and returns a receipt whose `undo` block carries how to reverse it. Emits a REWIND_APPLIED receipt event.',
    category: 'rewind',
    scopes: ['write:checkpoints'],
    transport: ['ws'],
    dangerous: true,
    inputSchema: REWIND_APPLY_INPUT_SCHEMA,
    outputSchema: REWIND_APPLY_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.host.register',
    title: 'Offer This Surface\'s Live Conversation for Rewind',
    description:
      'Register the conversation this surface is running for a session, so a conversation-scope rewind of it can actually be served. Only the process holding the messages can count or drop them: without this, rewind.plan for a session hosted anywhere but the daemon reports the conversation half unavailable, and files rewind is unaffected either way. Re-registering with the hostId returned here RENEWS the offer; registering without one claims the session and replaces whoever held it, answering that surface\'s outstanding requests as unavailable. The registration is a lease, not a reservation — it lapses unless the surface keeps taking its requests, and nothing about it survives a daemon restart, because a claim about a live process is worthless once the process on either end may be gone.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_HOST_REGISTER_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_HOST_REGISTER_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.host.release',
    title: 'Withdraw a Conversation Rewind Offer',
    description:
      'Withdraw this surface\'s offer to serve a session\'s conversation — when the session ends, or the surface is going away. Outstanding requests put to it are answered unavailable rather than left to time out. Only the registered host may release its own session; anyone else is refused.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_HOST_RELEASE_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_HOST_RELEASE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.hosts.list',
    title: 'List Conversation Rewind Hosts',
    description:
      'Which sessions have a surface offering their live conversation right now, how each surface names itself, and when its lease runs out. This is what makes "conversation rewind is unavailable for that session" checkable rather than something a person has to take on trust.',
    category: 'rewind',
    scopes: ['read:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_HOSTS_LIST_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_HOSTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.requests.take',
    title: 'Take Conversation Rewind Requests',
    description:
      'Collect the conversation questions waiting for this host — how many messages a rewind to an anchor would drop, or a request to actually drop them — and renew its lease, because a surface that is polling is a surface that is alive. With nothing waiting, pass waitMs to hold the call open until something arrives; an empty result is a normal answer, not an error. Answer each request with rewind.conversation.requests.answer before its expiresAt, or the caller waiting on it is told, honestly, that this surface did not answer in time.',
    category: 'rewind',
    scopes: ['read:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_REQUESTS_TAKE_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_REQUESTS_TAKE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.requests.answer',
    title: 'Answer a Conversation Rewind Request',
    description:
      'Report what this surface found or did. Which fields are expected follows from the REQUEST, which already says whether it was a preview or a rewind — an answer that restated that could only disagree with it, silently. For a preview: messagesToDrop and messagesRemaining. For a rewind: droppedMessages and the undoSnapshotId that restores them. For either, a non-empty unavailableReason instead, which is the honest answer when the conversation is gone or this surface cannot serve it — and saying so beats staying silent, because silence becomes a timeout and a timed-out rewind cannot tell whether the messages were dropped. Only the surface a request was put to may answer it.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_REQUESTS_ANSWER_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_REQUESTS_ANSWER_OUTPUT_SCHEMA,
  }),
];
