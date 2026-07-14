# Live acceptance: power sleep ownership and the observed-agent steer channel

Date: 2026-07-14

This record captures live, on-host acceptance evidence for two capabilities that
previously had only fixture-backed coverage or a skipped live leg. Both legs now
exercise for real on a Linux host with a healthy system D-Bus / logind session
and a running tmux server. Each leg skips honestly (with a printed reason) when
its host dependency is absent, so the suite stays green in environments that
cannot run it.

## Context

The sleep-edge watcher in the Linux power seam spawned a `dbus-monitor`
subscription to logind's `PrepareForSleep` signal but nothing reaped it: an
exiting or crashed process left the watcher parented to init. Repeated
constructions (mostly test runs) accumulated orphaned watchers until the system
bus's per-user connection quota was exhausted, which cut every process of that
user off from the system bus (logind unreachable). The orphans were cleared
manually and the watcher was given the same lifetime discipline the inhibitor
children already had: owner-pid stamping, process exit/signal cleanup, and
dead-owner reaping at start. The watcher spawn is now an injectable seam, and the
generic runtime-services factory defaults to a non-spawning power seam (only the
standalone daemon opts into the host seam), so tests never launch a real watcher
except one deliberate live leg.

Separately, the observed-external-agents steer channel (tmux pane, three-send
recipe) had only authoring-time argv fixtures and no recorded end-to-end proof
that the channel actually carries text on a real tmux server.

## Live acceptance evidence

Environment: Linux host, healthy logind session (`systemd-inhibit --list` works;
a plain-shell inhibit/release cycle succeeds), `dbus-monitor` present, tmux
server running.

### Power sleep ownership (test/power-sleep-ownership.test.ts)

- Live logind inhibit/release proven. An unprivileged idle inhibitor is
  genuinely held via logind (it appears in `systemd-inhibit --list`) and is gone
  after release — no root, no sudo. The live leg now exercises rather than
  skipping. Printed live-path output:

  > [power test] live logind proof EXERCISED: an unprivileged idle inhibitor was
  > genuinely held (listed by systemd-inhibit) and released via logind on this host.

- Sleep-edge watcher spawn/reap proven, and the leak fix verified by process
  count. A real `dbus-monitor` watcher spawns, carries its owner-pid stamp, and
  the unsubscribe closure reaps it; a `try/finally` guarantees no watcher of
  this test's owner pid survives even on failure. Printed live-path output:

  > [power test] live sleep-edge watcher proof EXERCISED: a real dbus-monitor
  > spawned, carried our owner-pid stamp, and the unsubscribe reaped it (no leak).

  Leak check: `pgrep -fc "dbus-monitor --system.*PrepareForSleep"` returned the
  same count (1, the host's own legitimately-parented watcher) before and after
  the full power test file ran — the fix leaves nothing behind.

### Observed-agent steer channel (test/observed-external-agents.test.ts)

- Live tmux steer proven end to end. The test creates its own uniquely-named
  tmux session running an agent-shaped interactive process, uses the real
  process-table discovery and pane resolution to find it as an observed
  `claude-code` row, runs the real three-send steer recipe against its pane, and
  reads the steered text back from the pane with `capture-pane`. It targets only
  its own session by exact name and kills only that session in a `finally`; it
  never lists, reads, resizes, sends to, or kills any session it did not create.
  Printed live-path output (session and marker names are per-run random):

  > [observed test] live tmux steer proof EXERCISED: discovered our own session
  > gv-obs-live-87be9b9f (pid 2322197) as an observed claude-code row, resolved
  > its tmux pane, ran the three-send recipe, and read the steered text
  > "gv-steer-af9cf480" back from the pane.

## Consequences

- Both features carry a live proof that runs on a suitable host and skips
  honestly elsewhere.
- The watcher-leak class cannot recur silently: the watcher is reaped on exit
  and reapable after a crash, and a unit test asserts the stamp/parse/reap
  contract without spawning a real process.
