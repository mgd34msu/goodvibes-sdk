# Automation And Watchers

The automation system provides durable jobs, runs, schedules, route bindings,
deliveries, and watcher services for daemon-hosted work.

Consumer apps interact through operator methods documented below. Daemon embedders wire automation through host runtime composition rather than a catch-all platform namespace.

The method lists below are an index. For the full request/response shape of each method — including the category each method is registered under (for example `watchers.list` under `watchers`, `services.status` under `services`) — see the generated [Operator method reference](./reference-operator.md), or fetch the live catalog at `GET /api/control-plane/methods` for the registration in your daemon build.

## Automation Domain

Automation records are split into jobs, runs, sources, routes, schedules, and
deliveries.

Operator methods:

- `automation.integration.snapshot`
- `automation.jobs.list`
- `automation.jobs.create`
- `automation.jobs.update`
- `automation.jobs.delete`
- `automation.jobs.enable`
- `automation.jobs.disable`
- `automation.jobs.run`
- `automation.runs.list`
- `automation.runs.get`
- `automation.runs.cancel`
- `automation.runs.retry`
- `automation.heartbeat.list`
- `automation.heartbeat.run`
- `scheduler.capacity`

Automation config controls enablement, max concurrent runs, run history,
default timeout, catch-up window, failure cooldown, and delete-after-run.

> **Core-verb rename (see CHANGELOG 1.0.0):** `automation.jobs.patch` was renamed to
> `automation.jobs.update` — the canonical verb is `update`, not `patch`. The
> separate `automation.jobs.pause` / `automation.jobs.resume` methods were
> retired: they were a byte-identical redundant lifecycle pair with
> `automation.jobs.disable` / `automation.jobs.enable` (same `{id, enabled}`
> output, same semantics — pause==disable, resume==enable). A caller-facing
> "pause"/"resume" verb should now invoke `automation.jobs.disable` /
> `automation.jobs.enable`. See
> [`packages/contracts/src/core-verbs.ts`](../packages/contracts/src/core-verbs.ts)
> and `docs/decisions/2026-07-06-core-verb-spec.md`.

## Schedules

The schedule endpoints manage host-owned schedule records:

- `automation.schedules.list`
- `automation.schedules.create`
- `automation.schedules.delete`
- `automation.schedules.enable`
- `automation.schedules.disable`
- `automation.schedules.run`

> **Core-verb rename (see CHANGELOG 1.0.0):** this family was renamed from the bare
> `schedules.*` (no namespace prefix) to `automation.schedules.*`. The bare
> name collided with two unrelated things that also used the word "schedule":
> the agent's own reminder/routine tooling (which called these methods under
> the bare name) and `knowledge.schedule(s).*` below (a different resource:
> recurring knowledge-ingestion jobs, not automation prompt jobs). The HTTP
> paths were already `/api/automation/schedules/*` — only the operator method
> id was inconsistent with its own route; the rename brings the two in line
> and removes the bare top-level `schedules` namespace entirely, leaving only
> two clearly-scoped "schedule" families: `automation.schedules.*` (this one)
> and `knowledge.schedule(s).*` (below).

Knowledge jobs also have their own schedule API. The single-record methods are singular — `knowledge.schedule.get`, `knowledge.schedule.save`, `knowledge.schedule.delete`, and `knowledge.schedule.enable` — while the list method is the plural `knowledge.schedules.list`. This singular-item/plural-list split is the CANONICAL namespace convention (see `core-verbs.ts`), not a special case — `automation.schedules.*` above has no separate single-item family because none of its callers need one yet.

## Route Bindings

Route bindings preserve the relationship between external surfaces and daemon
state. They are used by channel replies, ntfy, Home Assistant, companion/chat
flows, and automation delivery.

Operator methods:

- `routes.snapshot`
- `surfaces.list`
- `routes.bindings.list`
- `routes.bindings.create`
- `routes.bindings.patch`
- `routes.bindings.delete`

Route bindings can carry surface kind, external id, thread id, channel id,
session id, job id, run id, and metadata.

## Deliveries

Deliveries track outbound results, surface-specific status, retries, and
dead-letter posture.

Operator methods:

- `deliveries.list`
- `deliveries.get`

The `integrations.delivery.sloEnforced` setting (default on) adds stricter retry/dead-letter
reporting when enabled.

## Watchers

Watchers are managed listener/poller services for external triggers and health.

Operator methods:

- `watchers.list`
- `watchers.create`
- `watchers.patch`
- `watchers.delete`
- `watchers.start`
- `watchers.stop`
- `watchers.run`

Watcher config controls enablement, poll interval, heartbeat interval, and
recovery window.

## Services

The service-management methods expose installation and runtime control for a
daemonized GoodVibes host.

Operator methods:

- `services.status`
- `services.install`
- `services.start`
- `services.stop`
- `services.restart`
- `services.uninstall`

## Next Reads

- [Runtime Orchestration](./runtime-orchestration.md)
- [Feature settings](./feature-settings.md)
- [Defaults](./defaults.md)
