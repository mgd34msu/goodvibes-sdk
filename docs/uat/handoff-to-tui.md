# UAT Handoff: TUI-Owned Items

This document covers findings from UAT Run 3 / 3b against SDK 0.21.23 that were triaged as **DEFERRED-TO-TUI** — meaning the SDK behaves correctly by design, and the required change (if any) lives in the TUI layer.

Version context: findings raised against TUI 0.19.12 / SDK 0.21.23.

---

## F7 — POST /api/v1/telemetry/otlp/v1/logs returns 404

**Finding**: UAT plan expected a POST endpoint at `/api/v1/telemetry/otlp/v1/logs` for OTLP log ingestion. The daemon returns 404.

**Triage**: DEFERRED-TO-TUI — working as designed.

**Design decision** (`otlp-no-post-ingest`, recorded 2026-04-19): The daemon is an **OTLP producer/exporter**, not a collector. It exports telemetry outbound to an OTLP-compatible sink (e.g. a Grafana Cloud endpoint, local Jaeger, etc.). It does not implement an inbound OTLP HTTP receiver. The GET-only export path (`GET /api/v1/telemetry/otlp/v1/logs`) allows the TUI to pull a snapshot of buffered log records for forwarding; inbound POST-ingest is explicitly out of scope at this layer.

**TUI action required**: Update the UAT plan and any TUI-side test scripts to remove the POST expectation. If inbound OTLP ingestion is a product requirement for a future release, it must be implemented as a separate collector service or a new route negotiated with the SDK team.

---

## F9 — POST /api/automation/jobs returns 400 "Missing required field: prompt"

**Finding**: UAT plan submitted a job creation request without a `prompt` field (or with a non-string value) and expected a 201 response. The daemon returned 400 `{ error: 'Missing required field: prompt' }`.

**Triage**: DEFERRED-TO-TUI — schema drift in the UAT plan.

**Design**: `handlePostSchedule` (runtime-automation-routes) requires `prompt` as a non-empty string. This requirement is intentional: every automation job must carry a textual prompt that the AI agent acts on; a job without a prompt would immediately error at execution time. The field has been required since the automation endpoint was introduced.

**UAT plan drift**: The UAT plan's request body omitted `prompt`, suggesting the plan was written against an earlier draft spec or the wrong version of the route contract.

**TUI action required**: Update all UAT automation job fixtures to include a `"prompt"` string field. Example minimal payload:

```json
{
  "prompt": "Run the nightly code analysis task",
  "sessionId": "<target-session-id>"
}
```

See `packages/daemon-sdk/src/runtime-automation-routes.ts` → `handlePostSchedule` for the full required-field list.

---

## Related SDK changes in 0.21.24

The following findings from the same UAT run were fixed in SDK 0.21.24 (not TUI-owned):

| Finding | Fix summary |
|---------|-------------|
| F16b | Companion-chat session-create now resolves provider/model from TUI registry when `resolveDefaultProviderModel` callback is injected into `CompanionChatRouteContext` |
| F17 | `DELETE /api/sessions/:id/inputs/:inputId` returns 409 when input is not in a cancellable state |
| F19 | `PATCH /api/channels/policies/:surface` implemented |
| F-PROV-009 | `GET /api/providers` response now includes `secretsResolutionSkipped: true` when secrets tier is unavailable |
| Arch #3 | `GET /api/runtime/scheduler` implemented (slots_total, slots_in_use, queue_depth, oldest_queued_age_ms) |
