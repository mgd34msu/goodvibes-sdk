/**
 * Compile-time pin: `IntegrationHelperService`'s construction scope is a
 * discriminated union, not two independently-optional bags.
 *
 * A service constructed with a `SessionSurface` reads and writes surface-scoped
 * paths; one constructed with the loose `workingDirectory` / `homeDirectory`
 * pair reads the unscoped legacy ones. Accepting BOTH at once would leave the
 * question "which paths does this service actually mean?" answerable only at
 * runtime, the exact ambiguity that produced continuity answers from
 * directories nothing had written to. The assertions below fail to compile if
 * the two shapes ever stop being mutually exclusive, mirroring the same pin
 * `SessionPersistenceOptions` carries in session-persistence-scope.ts.
 *
 * Everything resolves through the package NAME so the exports map is exercised
 * exactly as a consumer install would (checked by `bun run types:check`).
 */
import type { ui } from '@pellux/goodvibes-sdk/platform/runtime';

declare function stub<T>(): T;

const services = stub<ui.IntegrationHelpersServices>();
const surface = stub<ui.IntegrationHelpersSurfaceScope['surface']>();

// Both single-shape constructions are valid.
const surfaceScoped: ui.IntegrationHelpersContext = { ...services, surface };
const legacyScoped: ui.IntegrationHelpersContext = {
  ...services,
  workingDirectory: '/project',
  homeDirectory: '/home/user',
};

// Mixing them is not.
// @ts-expect-error, a surface and the loose workingDirectory/homeDirectory pair are mutually exclusive; the surface already names the project root.
const mixed: ui.IntegrationHelpersContext = {
  ...services,
  surface,
  workingDirectory: '/project',
  homeDirectory: '/home/user',
};

// A context with neither shape is not a valid construction either.
// @ts-expect-error, the scope half is required: a service must know which directories it means.
const scopeless: ui.IntegrationHelpersContext = { ...services };

// Reference the bindings so they are not reported as unused.
export type Pinned = [typeof surfaceScoped, typeof legacyScoped, typeof mixed, typeof scopeless];
