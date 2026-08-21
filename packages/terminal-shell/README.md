# @pellux/goodvibes-terminal-shell

Shared terminal-shell plumbing for GoodVibes daemon front-ends. Two front-ends drive a full-screen terminal UI over the same daemon runtime, and they must keep a specific slice of that runtime wiring **identical**. When copies of it drift, real defects ship. This package is the single home for that slice, so each front-end consumes one implementation instead of maintaining a parallel copy.

## Install

```sh
npm install @pellux/goodvibes-terminal-shell
```

## What belongs here

Plumbing that must not drift between front-ends:

- **Gateway verb-group composition.** `attachWsOnlyGatewayVerbHandlers(catalog, deps)` binds the ws-only verb DESCRIPTORS (`fleet.*`, `checkpoints.*`, `sessions.search`, `push.*`) to their HANDLERS together, so a verb can never be descriptor-present but handler-absent. A descriptor with no handler answers `501 "Gateway method is not invokable"` over both websocket and HTTP invoke. Registering the two together is what prevents that. `createArchivableFleetRegistry(deps)` builds the one shared, archive-aware process registry the `fleet.*` verbs query.
- **Terminal enter/restore sequencing.** `createTerminalLifecycle(deps)` owns the alt-screen enter, the idempotent synchronous restore (leave the alt screen, or clear the primary viewport **without** `ESC[3J` so scrollback survives, then show the cursor on the screen the shell prompt lands on), and the restored-state gate `isTerminalRestored()`. The canonical escape sequences live in `TERMINAL_ESCAPES`.
- **Render-tick coalescing.** `createRenderScheduler(renderNow, scheduleFlush?, isReleased?)` collapses a within-tick burst of render requests into exactly one composite. Wire its third `isReleased` argument to the lifecycle's `isTerminalRestored()` so a late frame after teardown cannot paint over the restored shell.
- **The `cluster` command family.** The cluster commands, their table rendering, and the remote daemon-target convention, so both front-ends answer `cluster` identically.
- **The CLI argument surface.** `parseGoodVibesCli` is a generic token/value/arity/refusal engine (`parseWithCatalog`) driven by a declarative catalog, exported as `GOODVIBES_CLI_CATALOG`, with its supporting redaction, config-override, endpoint-resolution, feature-flag, and network-posture modules. A front-end that needs a different vocabulary supplies a different catalog against the same engine instead of forking the parser.
- **The terminal idiom.** The arithmetic and policy a character-cell surface needs before it can draw: capability probing and color downsampling, shell/split/overlay geometry, display-width text fitting, escape-sequence sanitization of untrusted content (`stripDangerousAnsi`), and key-semantics conventions such as the delete-key policy.
- **Shared UI conventions.** The pieces two terminal front-ends must answer identically or feel like different products: bottom-bar composition, conversation-tree rails, tool-result fold policy, transcript layout constants, text selection, the infinite conversation history buffer, the bookmark modal, the model-picker provider filter, and MCP config auto-reload.
- **The descriptor/handler conformance gate** and the terminal output guard, each on its own subpath. See below.

Every capability is a thin, dependency-injected wrapper: the front-end passes its concrete managers (process registry, checkpoint manager, session broker, secrets manager, approval broker, shell paths, terminal I/O) in, and this package owns the wiring.

## What does NOT belong here

Surface that front-ends legitimately diverge on, and which must stay in each app:

- Panels, views, and read-models. The geometry arithmetic they share lives here; deciding what to draw stays in the app.
- Theming and concrete rendering
- Keybinding maps and input handling, beyond the shared key-semantics conventions above
- Command surfaces and slash commands, beyond the shared catalog engine and the `cluster` family
- Application shutdown policy (draining services, persisting sessions, exit codes). Each app calls this package's terminal restore for the hand-back, but owns its own teardown.

## Subpath entry points

`./conformance` carries the descriptor/handler gate described below.
`./terminal-output-guard` carries `allowTerminalWrite` and the guard installers
(`installTerminalOutputGuard`, `installFullScreenTerminalOutputGuard`) on their
own import path, so a renderer that only needs the write guard does not load the
gateway and fleet graph on its startup path.

## The conformance gate

The exact regression this package exists to prevent, a registered descriptor with no handler, is catchable in your own CI. Compose your daemon/gateway catalog exactly as production does, then assert every descriptor is invokable:

```ts
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';

test('every registered gateway descriptor has a handler', () => {
  const catalog = composeMyDaemonCatalog();
  assertEveryDescriptorHasHandler(catalog); // throws with the offending ids
});
```

`findMethodsMissingHandlers(catalog, options)` returns the offending ids instead of throwing. Both accept `onlyIds` or `ignoreIds` for catalogs whose builtin descriptors get handlers from a different layer. The catalog is read through a narrow structural view, so any `GatewayMethodCatalog`-shaped object works.
