# Automation and watchers

The automation system runs prompts on a schedule instead of waiting for a
conversation to start one. A **job** is the durable record of what to run and
when; each time it fires it produces a **run**, the record of one execution
attempt with its own status, timing, and output. A job's trigger is described
by a **source** (a cron expression, a fixed interval, a one-off time, a
webhook, or an external watcher), and where its output goes is described by a
**route binding** and a **delivery**, the record of what actually happened
when that output tried to reach a surface. **Schedules** are the host-owned
records that turn a source description into something the engine actually
fires on. Consumer apps interact with all of this through the operator
methods documented below; daemon embedders wire automation through host
runtime composition rather than a catch-all platform namespace.

The method lists in this document are an index, not the full contract. For
the request and response shape of each method, including the category it is
registered under (for example `watchers.list` under `watchers`,
`services.status` under `services`), see the generated
[Operator method reference](./reference-operator.md), or fetch the live
catalog at `GET /api/control-plane/methods` for the registration in your
daemon build.

## Automation domain

Automation records split into jobs, runs, sources, routes, schedules, and
deliveries, each covering one piece of "what runs, when, and what happened."

The operator methods cover the job lifecycle, run history and intervention,
heartbeat processing, and scheduler capacity.

| Method | What it does |
| --- | --- |
| `automation.integration.snapshot` | Return the automation integration snapshot |
| `automation.jobs.list` | Return automation jobs and recent runs, optionally paginated with `limit`/`cursor` |
| `automation.jobs.create` | Create a durable automation job |
| `automation.jobs.update` | Update a durable automation job |
| `automation.jobs.delete` | Delete a durable automation job |
| `automation.jobs.enable` / `automation.jobs.disable` | Turn a job on or off without deleting it |
| `automation.jobs.run` | Trigger a job immediately |
| `automation.runs.list` | Return run history, optionally paginated and filterable with `since` for away-digest reads |
| `automation.runs.get` | Return a single run record |
| `automation.runs.cancel` | Cancel an active run |
| `automation.runs.retry` | Retry a completed or failed run |
| `automation.heartbeat.list` | Return jobs queued for the next heartbeat |
| `automation.heartbeat.run` | Process jobs queued for the next heartbeat |
| `scheduler.capacity` | Return the scheduler capacity snapshot: total slots, in-use slots, queue depth, and oldest queued run age |

`automation.jobs.create` accepts a `kind` of `cron`, `every`, or `at`, and the
schedule field required alongside it depends on which kind is chosen. It is a cron
expression for `cron` (also accepted nested as `schedule.expression`), an
interval for `every`, or a fixed timestamp for `at`. A bare `{ prompt }` with
no schedule information is never a complete call; the job also carries the
model and provider to run it under, an execution intent describing how the
session is created, a delivery policy for where the output goes, and a
failure policy for what happens after a run fails.

Automation config controls whether the subsystem runs at all, how much of it
runs at once, and how long its history is kept:

| Key | Default | What it controls |
|---|---|---|
| `automation.enabled` | `true` | Master gate for the subsystem: durable jobs, schedule evaluation, run history. With no jobs defined it idles. |
| `automation.maxConcurrentRuns` | `4` | How many automation runs may execute at the same time. |
| `automation.runHistoryLimit` | `100` | Run history entries retained per job before the oldest are dropped. |
| `automation.defaultTimeoutMs` | `900000` (15 minutes) | Execution timeout applied to a run that does not set its own. |
| `automation.catchUpWindowMinutes` | `30` | How long after daemon startup the engine will still catch up runs it missed while it was down. |
| `automation.failureCooldownMs` | `300000` (5 minutes) | Cooldown enforced after a failed run before the job is eligible to run again. |
| `automation.deleteAfterRun` | `false` | Whether a one-shot job (`kind: 'at'`) deletes itself after its first successful run. |

> **Core-verb rename (see CHANGELOG 1.0.0):** `automation.jobs.patch` was renamed to
> `automation.jobs.update`. The canonical verb is `update`, not `patch`; the
> HTTP method on the route (`PATCH /api/automation/jobs/{jobId}`) is
> unaffected, only the operator-method id changed. The separate
> `automation.jobs.pause` / `automation.jobs.resume` methods were retired.
> They were a byte-identical redundant lifecycle pair with
> `automation.jobs.disable` / `automation.jobs.enable` (same `{id, enabled}`
> output, same semantics, pause==disable, resume==enable). A caller-facing
> "pause"/"resume" verb should now invoke `automation.jobs.disable` /
> `automation.jobs.enable`. `patch`, `pause`, and `resume` are permanently
> banned verb tails (`packages/contracts/src/core-verbs.ts`) and cannot
> reappear under any automation method id. See
> [`packages/contracts/src/core-verbs.ts`](../packages/contracts/src/core-verbs.ts)
> and `docs/decisions/2026-07-06-core-verb-spec.md`.

## Schedules

A schedule is a host-owned record of a recurring or one-off trigger,
independent of the job it fires. The schedule endpoints manage those records.

| Method | What it does |
| --- | --- |
| `automation.schedules.list` | Return schedule records |
| `automation.schedules.create` | Create a schedule record |
| `automation.schedules.delete` | Delete a schedule record |
| `automation.schedules.enable` / `automation.schedules.disable` | Turn a schedule on or off without deleting it |
| `automation.schedules.run` | Trigger a schedule immediately |

> **Core-verb rename (see CHANGELOG 1.0.0):** this family was renamed from the bare
> `schedules.*` (no namespace prefix) to `automation.schedules.*`. The bare
> name collided with two unrelated things that also used the word "schedule":
> the agent's own reminder/routine tooling (which called these methods under
> the bare name) and `knowledge.schedule(s).*` below (a different resource:
> recurring knowledge-ingestion jobs, not automation prompt jobs). The HTTP
> paths were already `/api/automation/schedules/*`. Only the operator method
> id was inconsistent with its own route. The rename brings the two in line
> and removes the bare top-level `schedules` namespace entirely, leaving only
> two clearly-scoped "schedule" families: `automation.schedules.*` (this one)
> and `knowledge.schedule(s).*` (below).

Knowledge jobs have their own, separate schedule API for recurring
knowledge-ingestion work, not automation prompt jobs. Its single-record
methods are singular, `knowledge.schedule.get`, `knowledge.schedule.save`,
`knowledge.schedule.delete`, and `knowledge.schedule.enable`, while the list
method is the plural `knowledge.schedules.list`. This singular-item and
plural-list split is the canonical namespace convention
(`packages/contracts/src/core-verbs.ts`) for a resource family that has both
a per-item action surface and a collection surface where the plural form
alone would be ambiguous about which one an action targets, not a special
case invented for knowledge. `automation.schedules.*` above has no separate
singular family because nothing needs one yet; introducing one defensively
"for symmetry" is explicitly against the convention.

## Route bindings

A route binding is the daemon's memory of which external conversation a piece
of state belongs to, a Telegram thread, an ntfy topic, a Home Assistant
callback, a companion-app chat session. Automation delivery, channel replies,
and other daemon-hosted work read and write these bindings so a reply lands
back in the same place the original message came from.

| Method | What it does |
| --- | --- |
| `routes.snapshot` | Return the route and binding integration snapshot |
| `surfaces.list` | Return registered channel and control surfaces |
| `routes.bindings.list` | Return configured route bindings |
| `routes.bindings.create` | Create or upsert a route binding |
| `routes.bindings.update` | Update an existing route binding |
| `routes.bindings.delete` | Delete an existing route binding |

> **Core-verb rename (see CHANGELOG 1.0.0):** `routes.bindings.patch` was renamed to
> `routes.bindings.update`, the same rename applied to `automation.jobs.patch`
> and `watchers.patch` below, for the same reason: `update` is the one
> canonical partial-mutation verb, and `patch` mirrored the HTTP method name
> instead of the operator-method vocabulary. The HTTP route
> (`PATCH /api/routes/bindings/{bindingId}`) is unaffected.

A route binding can carry surface kind, external id, thread id, channel id,
session id, job id, run id, and metadata, so a single record can describe
where a job's output should land regardless of which of those identifiers the
destination surface actually organizes around.

## Deliveries

A delivery is the outcome of one attempt to get a message to a surface:
whether it landed, how many times it was retried, and whether it ended up
dead-lettered after exhausting its retries.

Operator methods:

- `deliveries.list`
- `deliveries.get`

The `integrations.delivery.sloEnforced` setting (default `true`) controls how
strictly a failure is tracked. On, a failure is classified retryable or
terminal, retried with exponential backoff, and a dead letter is logged at
error level and surfaced in integration diagnostics, replayable via
`/notify replay`. Off, dead letters are logged at warn level only. An
explicit per-queue `sloEnforced` option, when a caller sets one, overrides
this default for that queue alone.

## Watchers

A watcher is a managed, checkpointed poller or listener over an external
source, CI status, a webhook endpoint, a health check, with its own recovery
behavior if the daemon restarts mid-poll. This is a different subsystem from
the automation jobs above. A job runs a prompt on a schedule, while a watcher
tracks the state of something external between polls and recovers a missed
window rather than re-running from scratch.

| Method | What it does |
| --- | --- |
| `watchers.list` | Return configured watchers and their runtime posture |
| `watchers.create` | Register a new watcher |
| `watchers.update` | Update an existing watcher |
| `watchers.delete` | Delete an existing watcher |
| `watchers.start` / `watchers.stop` | Start or stop a watcher instance |
| `watchers.run` | Trigger a watcher immediately |

> **Core-verb rename (see CHANGELOG 1.0.0):** `watchers.patch` was renamed to
> `watchers.update`, the same rename applied to `automation.jobs.patch` and
> `routes.bindings.patch` above. The HTTP route
> (`PATCH /api/watchers/{watcherId}`) is unaffected.

Watcher config controls whether the subsystem runs, how often it polls, and
how it recovers from a restart:

| Key | Default | What it controls |
|---|---|---|
| `watchers.enabled` | `true` | Master gate for managed watcher/listener services. With none configured the framework idles. |
| `watchers.pollIntervalMs` | `60000` | Polling interval for watcher sources. |
| `watchers.heartbeatIntervalMs` | `15000` | Heartbeat interval for watcher services, how often a running watcher checks in. |
| `watchers.ciPollIntervalMs` | `60000` | Cadence for the daemon's recurring CI-status poll specifically; the poller enforces a 15-second floor regardless of this setting, to respect the status source's rate limits. |
| `watchers.recoveryWindowMinutes` | `10` | How far back a restarted watcher looks to catch up on missed events. |

A separate, unrelated subsystem, the stream/condition/on-exit trigger family
under `platform/triggers/`, shares a confusingly similar config prefix
(`watchers.triggers.*`) but is a different feature. It supervises long-lived
child processes and fires on log patterns, declarative condition checks, or
process exit, rather than polling an external source. It has no operator
methods of its own today, so it is configuration-only; see the config keys
under `watchers.triggers.*` if you are looking for that feature rather than
the polling watchers documented above.

## Services

The service-management methods expose installation and runtime control for a
daemonized GoodVibes host, the platform service itself, not a job or a
watcher.

| Method | What it does |
| --- | --- |
| `services.status` | Return platform service installation and runtime posture |
| `services.install` / `services.uninstall` | Install or uninstall the GoodVibes platform service |
| `services.start` / `services.stop` / `services.restart` | Control the running platform service |

## Next reads

- [Runtime Orchestration](./runtime-orchestration.md)
- [Feature settings](./feature-settings.md)
- [Defaults](./defaults.md)
