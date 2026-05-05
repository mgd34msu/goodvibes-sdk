# Automation And Watchers

The automation system provides durable jobs, runs, schedules, route bindings,
deliveries, and watcher services for daemon-hosted work.

Consumer apps interact through operator methods documented below. Daemon embedders wire automation through host runtime composition rather than a catch-all platform namespace.

## Automation Domain

Automation records are split into jobs, runs, sources, routes, schedules, and
deliveries.

Operator methods:

- `automation.integration.snapshot`
- `automation.jobs.list`
- `automation.jobs.create`
- `automation.jobs.patch`
- `automation.jobs.delete`
- `automation.jobs.enable`
- `automation.jobs.disable`
- `automation.jobs.pause`
- `automation.jobs.resume`
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

## Schedules

The schedule endpoints manage host-owned schedule records:

- `schedules.list`
- `schedules.create`
- `schedules.delete`
- `schedules.enable`
- `schedules.disable`
- `schedules.run`

Knowledge jobs also have their own schedule API under `knowledge.schedule.*`.

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

The `integration-delivery-slo` feature flag adds stricter retry/dead-letter
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
- [Feature Flags](./feature-flags.md)
- [Defaults](./defaults.md)
