# @pellux/goodvibes-terminal-shell

Shared terminal-shell plumbing for GoodVibes daemon front-ends. Two front-ends drive a full-screen terminal UI over the same daemon runtime, and they must keep a specific slice of that runtime wiring **identical**. When copies of it drift, real defects ship. This package is the single home for that slice, so each front-end consumes one implementation instead of maintaining a parallel copy.

## Install

```sh
npm install @pellux/goodvibes-terminal-shell
```

## What belongs here

Plumbing that must not drift between front-ends:

- **Gateway verb-group composition** — `attachWsOnlyGatewayVerbHandlers(catalog, deps)` binds the ws-only verb DESCRIPTORS (`fleet.*`, `checkpoints.*`, `sessions.search`, `push.*`) to their HANDLERS together, so a verb can never be descriptor-present but handler-absent. A descriptor with no handler answers `501 "Gateway method is not invokable"` over both websocket and HTTP invoke; registering the two together is what prevents that. `createArchivableFleetRegistry(deps)` builds the one shared, archive-aware process registry the `fleet.*` verbs query.
- **Terminal enter/restore sequencing** — `createTerminalLifecycle(deps)` owns the alt-screen enter, the idempotent synchronous restore (leave the alt screen, or clear the primary viewport **without** `ESC[3J` so scrollback survives; show the cursor on the screen the shell prompt lands on), and the restored-state gate `isTerminalRestored()`. The canonical escape sequences live in `TERMINAL_ESCAPES`.
- **Render-tick coalescing** — `createRenderScheduler(renderNow, scheduleFlush?, isReleased?)` collapses a within-tick burst of render requests into exactly one composite. Wire its third `isReleased` argument to the lifecycle's `isTerminalRestored()` so a late frame after teardown cannot paint over the restored shell.
- **The descriptor/handler conformance gate** — see below.

Every capability is a thin, dependency-injected wrapper: the front-end passes its concrete managers (process registry, checkpoint manager, session broker, secrets manager, approval broker, shell paths, terminal I/O) in, and this package owns the wiring.

## What does NOT belong here

Surface that front-ends legitimately diverge on, and which must stay in each app:

- Panels, views, and read-models
- Rendering, layout, and theming
- Keybindings and input handling
- Command surfaces and slash commands
- Application shutdown policy (draining services, persisting sessions, exit codes) — each app calls this package's `restoreTerminal()` for the terminal hand-back, but owns its own teardown.

## The conformance gate

The exact regression this package exists to prevent — a registered descriptor with no handler — is catchable in your own CI. Compose your daemon/gateway catalog exactly as production does, then assert every descriptor is invokable:

```ts
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';

test('every registered gateway descriptor has a handler', () => {
  const catalog = composeMyDaemonCatalog();
  assertEveryDescriptorHasHandler(catalog); // throws with the offending ids
});
```

`findMethodsMissingHandlers(catalog, options)` returns the offending ids instead of throwing. Both accept `onlyIds` / `ignoreIds` for catalogs whose builtin descriptors get handlers from a different layer. The catalog is read through a narrow structural view, so any `GatewayMethodCatalog`-shaped object works.
