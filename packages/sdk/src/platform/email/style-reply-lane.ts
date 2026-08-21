/**
 * Personal Ops lane descriptor for the writing-style-matched draft-reply flow.
 *
 * NOT SHIPPED / NOT WIRED (capability-honesty, 2026-07)
 * ──────────────────────────────────────────────────────────────────────
 * These descriptors are intentionally NOT wired into the advertised Personal
 * Ops inbox lane. The Agent has no reader for the user's own sent-message
 * corpus, so it cannot honestly claim a writing-style match, and the
 * competitive feature inventory records writing-style-matched draft replies as
 * "not yet shipped". The pure composer (style-reply.ts) and these descriptors
 * stay as tested internal code for when the sent-corpus input and a real
 * compose route ship together. Do not re-add buildStyleReplyLaneAdditions to
 * the surface's buildLanes() until then.
 *
 * This module defines the workflow and live-record objects that would surface
 * the style-reply capability inside the Personal Ops 'inbox' lane once the
 * capability is genuinely shipped.
 *
 * ── Why the return types are inferred ─────────────────────────────────────
 *
 * Personal Ops is a product SURFACE concept: the `PersonalOpsWorkflow` and
 * `PersonalOpsLiveRecord` types live in the surface that renders the lane, and
 * re-declaring them here would put a second copy of a product's type system in
 * the SDK for it to drift from. So these functions return exactly the object
 * literals they build, and the surface pins them to its own types at the point
 * of use, where a mismatch becomes a compile error in the product, which is
 * where it belongs. The literal annotations below exist so that pinning
 * succeeds: without them the union-valued fields widen to `string`.
 *
 * BEFORE-SEND REVIEW BOUNDARY (enforced here and in style-reply.ts)
 * ──────────────────────────────────────────────────────────────────────
 * The style-reply lane ONLY produces a DRAFT. Composition is local-only in
 * nature (the live record's typed `effect` is 'read-only', the closest value
 * in the surface's live-record effect union, and it carries no `freshness`, so
 * it is never counted as a provider read). Sending requires the confirmed send path
 * (EmailService.sendMail with confirm:true, or an MCP connector action) with
 * explicit user review and confirmation before any provider effect is executed.
 *
 * The confirmationRequired flag on the send follow-up route is always true.
 * Auto-send is architecturally impossible from this module.
 *
 * INTEGRATION
 * ────────────
 * A surface consumes this from its Personal Ops lane builder. Registering a new
 * top-level harness mode for it is a separate decision made in that surface's
 * mode catalog; nothing here registers one.
 */

// ---------------------------------------------------------------------------
// Workflow status helper
// ---------------------------------------------------------------------------

/**
 * Determine the workflow status for the style-reply lane.
 *
 * The lane is 'ready' when at least one email connector or daemon method is
 * available (signalled by hasEmailCapability = true).  Otherwise 'needs-setup'.
 */
export function styleReplyWorkflowStatus(hasEmailCapability: boolean): 'ready' | 'needs-setup' {
  return hasEmailCapability ? 'ready' : 'needs-setup';
}

// ---------------------------------------------------------------------------
// Workflow descriptor
// ---------------------------------------------------------------------------

/**
 * Personal Ops workflow card for the writing-style-matched draft-reply flow.
 *
 * Presence in inbox lane's `workflows` array makes it discoverable via
 * `personal_ops action:"intake" query:"draft reply in my style"` and similar.
 */
export function styleReplyWorkflow(hasEmailCapability: boolean) {
  const status = styleReplyWorkflowStatus(hasEmailCapability);
  return {
    id: 'inbox-style-matched-draft-reply',
    label: 'Writing-style-matched draft reply',
    status,
    summary:
      'Compose a draft email reply that mirrors the user\'s own writing style '
      + '(tone, length, greeting, sign-off) inferred from prior sent messages. '
      + 'The draft is produced locally and NEVER auto-sent.',
    next: status === 'ready'
      ? 'Call personal_ops action:"read" laneId:"inbox" recordId:"inbox-style-reply-draft" '
        + 'with the inbound message and optional key-points context. '
        + 'Review the composed draft in the Agent transcript before sending through the confirmed send route.'
      : 'Set up an email connector or IMAP/SMTP config (email.enabled = true) before drafting in the user\'s style.',
    modelRoute: 'personal_ops action:"read" laneId:"inbox" recordId:"inbox-style-reply-draft" '
      + 'fields:{inboundFrom:"...",inboundSubject:"...",inboundBodyPreview:"...",context:"key points to include"} '
      + 'confirm:true explicitUserRequest:"draft a reply in my style"',
    inspectRoutes: [
      'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      'personal_ops action:"intake" query:"draft reply in my style" includeParameters:true',
    ],
    prerequisites: status === 'needs-setup'
      ? ['Connect a Google account with /google setup, or configure IMAP/SMTP directly with /email config, before using style-matched drafts.']
      : [
        'The user must identify the inbound message (from, subject, bodyPreview).',
        'Optionally supply key-points context to weave into the draft.',
        'Review the draft in the Agent transcript before any send route.',
      ],
    runBoundary:
      'Composing stays local (local-only effect). '
      + 'Sending requires the confirmed SMTP/connector route with explicit user review of recipients and body.',
  };
}

// ---------------------------------------------------------------------------
// Live record descriptor
// ---------------------------------------------------------------------------

/**
 * Live record for the inbox lane's liveRecords array that exposes the
 * style-reply composer as a Personal Ops read route.
 *
 * The `effect` is 'read-only' (the local composer performs no provider write);
 * it carries no `freshness` so it is not counted as a provider read. Send is a
 * separate confirmed route.
 */
export function styleReplyLiveRecord(hasEmailCapability: boolean) {
  const status = hasEmailCapability ? 'ready' : 'needs-setup';
  return {
    id: 'inbox-style-reply-draft',
    label: 'Draft reply in my writing style',
    status,
    summary:
      'Locally compose a draft email reply that mirrors the user\'s tone, '
      + 'length, greeting, and sign-off. The draft is shown for review; '
      + 'no send occurs until the user explicitly confirms through the send route.',
    userRoute: 'Agent Workspace → Personal Ops → Inbox → Draft reply in my style',
    modelRoute:
      'personal_ops action:"read" laneId:"inbox" recordId:"inbox-style-reply-draft" '
      + 'fields:{inboundFrom:"<from>",inboundSubject:"<subject>",inboundBodyPreview:"<preview>",context:"<key points>"} '
      + 'confirm:true explicitUserRequest:"draft a reply in my style"',
    tags: ['style-reply', 'draft', 'inbox', 'personal-ops', 'writing-style'],
    // Note: the surface's live-record effect union only supports
    // 'read-only' | 'confirmed-effect'. Style-reply composition has no provider
    // effect, so 'read-only' is the correct value. The local-only nature is
    // communicated via the followUpRoutes policy and reviewBoundary.
    effect: 'read-only' as const,
    capability: 'inbox-style-reply-draft',
    confirmationRequired: false, // local composition; no provider effect
    requiredFields: ['inboundFrom', 'inboundSubject'],
    optionalFields: ['inboundBodyPreview', 'context'],
    sampleInput: {
      inboundFrom: 'Alice Smith <alice@example.com>',
      inboundSubject: 'Project update',
      inboundBodyPreview: 'Hi, just checking in on the project status...',
      context: 'Mention the milestone is on track and you will share a detailed update by Friday.',
    },
    followUpRoutes: [
      {
        id: 'send-after-review',
        label: 'Send reviewed draft (confirmed)',
        effect: 'confirmed-effect' as const,
        modelRoute:
          'email action:"send" to:"<recipient>" subject:"Re: <subject>" body:"<reviewed draft>" '
          + 'confirm:true explicitUserRequest:"send this reply"',
        requiresConfirmation: true,
        policy:
          'Sending requires confirm:true, explicit user review of the exact '
          + 'recipients and body, and must go through the confirmed SMTP or '
          + 'connector send path. Auto-send is not permitted.',
      },
    ],
    // No `freshness`: this record is a LOCAL composition, not a provider-backed
    // read, so it must not be classified as a fresh provider record (which would
    // inflate the Personal Ops queue's freshProviderReads count). Drafts are
    // composed locally from supplied fields and are session-local.
  };
}

// ---------------------------------------------------------------------------
// Aggregated export for easy import in buildLanes()
// ---------------------------------------------------------------------------

export interface StyleReplyLaneAdditions {
  readonly workflow: ReturnType<typeof styleReplyWorkflow>;
  readonly liveRecord: ReturnType<typeof styleReplyLiveRecord>;
}

/**
 * Returns both the workflow and live record for the style-reply lane.
 * Call once per buildLanes() invocation; result is deterministic.
 */
export function buildStyleReplyLaneAdditions(hasEmailCapability: boolean): StyleReplyLaneAdditions {
  return {
    workflow: styleReplyWorkflow(hasEmailCapability),
    liveRecord: styleReplyLiveRecord(hasEmailCapability),
  };
}
