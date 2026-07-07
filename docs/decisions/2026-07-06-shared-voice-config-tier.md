# A shared, surface-root-independent config tier for the voice (tts.*) settings

- **Date:** 2026-07-06
- **Status:** Accepted
- **Scope:** SDK enabler only. Consumer rewires (TUI/agent/webui reads) adopt this and land
  after the SDK lands.
- **Builds on:** `docs/decisions/2026-07-06-config-sharing-shared-tier-and-secret-read.md` (E7).

## Context (reality, verified)

Config is one SDK engine (`platform/config/manager.ts` `ConfigManager`) fanned into per-surface
silos by a `surfaceRoot` string: each surface reads/writes `~/.goodvibes/<surface>/settings.json`.
The voice settings — `tts.provider`, `tts.voice`, `tts.speed`, `tts.llmProvider`, `tts.llmModel`
— lived in those silos, so a value set on one surface did not reach another. The TUI and daemon
both run under `surfaceRoot: 'tui'`, so terminal + desktop + daemon already shared a file; the
**agent** runs under `surfaceRoot: 'agent'` and read its voice from `~/.goodvibes/agent/settings.json`.
Result: setting a voice in the webui (which writes through the daemon's `'tui'` store) left the
agent's spoken voice unchanged — while the surface labeled the voice "one voice across terminal,
desktop, and agent." The label named the agent as a party to a sharing guarantee that did not
hold (Stage-5 cohesion review, Finding 1).

`resolveSharedDirectory()` (`platform/runtime/surface-root.ts`) is a surface-neutral path helper.
The E7 decision already blessed a literal on-disk neutral store at
`~/.goodvibes/shared/{settings.json,secrets.enc}` (`surfaceRoot: 'shared'`) as an available option
for a daemon host that wants an explicitly-named neutral store.

## Decision

### 1. A designated set of shared keys resolves from one surface-root-independent file

The voice keys (`SHARED_CONFIG_KEYS` in `platform/config/shared-config-tier.ts`) read from and
write to `~/.goodvibes/shared/settings.json` — the E7 shared-tier path, resolved via
`resolveSharedDirectory(homeDir, 'shared', 'settings.json')`, which is independent of any surface
root. Every surface's `ConfigManager` derives the same path from the same `homeDir`, so all local
surfaces (tui, agent, daemon) resolve the same voice directly. The webui, a browser that cannot
read `~/.goodvibes`, shares transitively: it reads/writes voice config through the daemon, whose
`ConfigManager` reads/writes this shared tier.

### 2. `tts.*` rides an on-disk shared *file*, not the daemon-served config snapshot

E7's daemon-served tier (`config.get`) carries `providers`/`channels`/`memory` categories, not
`tts.*`, and exists mainly to reach the browser. The least-friction honest design for the voice
keys is the on-disk shared **file** E7 kept available: it needs no new wire method, reuses every
existing path/load/save codepath, and makes the label true for the agent — the one surface that
was actually diverging — with the daemon covering the browser. Adding `tts.*` to the daemon
snapshot was rejected as unnecessary surface area for keys that are host-local by nature.

### 3. Resolution order (documented and inspectable)

For a shared key: **defaults < global surface settings < project surface settings < SHARED TIER
< CLI overrides**. The shared tier is overlaid LAST among the persisted layers, so a present
shared value wins over the surface silo. A shared key **absent** from the shared file is left at
its surface-local value — existing setups never break, and a user who never sets a shared voice
keeps their per-surface one. `ConfigManager.describeConfigKeySource(key)` reports the tier a live
value resolves from (`shared` / `project` / `global` / `default`) plus whether the key is
shareable and the shared-tier path, so the order is inspectable, not merely documented.

### 4. Writes to a shared key go to the shared tier

`ConfigManager.set('tts.voice', …)` persists to the shared file (only the set key is written,
never promoting unrelated surface-local values), not the surface silo. `reset()` of a shared key
propagates the reset into the shared file too, so a stale shared value cannot re-overlay and
defeat the reset. Validation, managed-lock enforcement, change listeners, and the config-change
hook are unchanged — only the persistence target differs.

### 5. No shared tier without a home directory

A `ConfigManager` constructed with `configDir` only and no `homeDir` (common in tests and
embedded uses) has no shared tier and behaves exactly as before. An explicit `sharedTierPath`
override is accepted for tests and for a host that wants a non-default neutral store.

## Alternatives rejected

- **Put `tts.*` into the daemon-served config snapshot.** Unnecessary wire surface for host-local
  keys; the on-disk shared file already makes the agent honest and the daemon already covers the
  browser.
- **Per-surface sync/import of the voice values.** Institutionalizes the divergence and still
  leaves a window where surfaces disagree.
- **Strip shared keys from the surface file on save.** Would erase the surface-local fallback that
  existing setups rely on. The surface silo keeps its value as the honest fallback; the shared
  tier simply wins when present.

## Consumer adoption (out of scope here, tracked for the adoption block)

TUI/agent/webui read the voice from the shared tier (the agent stops reading `tts.*` from its own
silo); the webui's `config.set` path continues to write through the daemon, whose store now writes
the shared tier. Only then does "one voice across terminal, desktop, and agent" hold end to end.
