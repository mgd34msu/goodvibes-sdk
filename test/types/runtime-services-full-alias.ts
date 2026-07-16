/**
 * Compile-time pin: `bootstrap.RuntimeServices` is the FULL runtime-services
 * composition interface — the stable public name for the type
 * `startHostServices` takes as its runtimeServices parameter. A fork that
 * composes its own runtime services names THIS alias instead of re-anchoring
 * through the fragile positional `Parameters<typeof startHostServices>[3]`.
 *
 * The assertions below fail to compile if:
 *   - the alias ever narrows to the published foundation slice (it must stay a
 *     strict superset — it carries the SDK-internal members the slice omits:
 *     memoryGovernor / cacheRegistry / pauseController / schedulers), or
 *   - the alias drifts away from the exact type `startHostServices` accepts.
 *
 * Everything resolves through the package NAME so the exports map is exercised
 * exactly as a consumer install would (checked by `bun run types:check`).
 */
import type { bootstrap } from '@pellux/goodvibes-sdk/platform/runtime';

// Mutual assignability == the alias IS the exact runtimeServices parameter type
// (index 3 of startHostServices) — no re-anchoring through the positional tuple.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type HostRuntimeServicesParam = Parameters<typeof bootstrap.startHostServices>[3];
const _aliasIsTheParamType: Exact<bootstrap.RuntimeServices, HostRuntimeServicesParam> = true;

declare function stub<T>(): T;

// The full interface is assignable INTO the narrow published slice (superset),
// proving the alias is not itself the slice.
declare const full: bootstrap.RuntimeServices;
const slice: bootstrap.RuntimeFoundationServicesSlice = full;

// ...and it carries the SDK-internal members the slice deliberately omits.
const memoryGovernor = full.memoryGovernor;
const cacheRegistry = full.cacheRegistry;
const pauseController = full.pauseController;

// The reverse does NOT hold: the narrow slice is NOT a full RuntimeServices.
// @ts-expect-error — the slice lacks memoryGovernor/cacheRegistry/... and the rest.
const notFull: bootstrap.RuntimeServices = stub<bootstrap.RuntimeFoundationServicesSlice>();

export { _aliasIsTheParamType, slice, memoryGovernor, cacheRegistry, pauseController, notFull };
