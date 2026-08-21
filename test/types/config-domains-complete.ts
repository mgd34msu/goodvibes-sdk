/**
 * Compile-time pin: `GoodVibesConfig` is COMPLETE from a consumer's vantage
 * point.
 *
 * `GoodVibesConfig` is assembled by declaration merging, each
 * `platform/config/schema-domain-*.ts` contributes its own
 * `declare module … { interface GoodVibesConfig }` block. Inside the SDK's own
 * program every one of those modules is loaded, so the merged type is always
 * complete there and an omission is invisible. A consumer's program loads only
 * the declarations its own imports reach.
 *
 * The value imports in schema.ts do NOT carry those blocks: TypeScript drops an
 * import from an emitted `.d.ts` when the declarations do not reference its
 * types, and `dist/platform/config/schema.d.ts` contained no reference to any
 * schema-domain module at all. Measured from this vantage point before the fix,
 * `'conversationGate'` and `'voice'` were both absent from
 * `keyof GoodVibesConfig`, so `config.getCategory('conversationGate')` was a
 * compile error against a key that ships, works, and has its own migration.
 * schema.ts now carries a bare side-effect import per domain, which IS
 * preserved in the emitted declarations.
 *
 * conversation-gate-config-reader.ts in this directory pins one consequence of
 * the same defect. This file pins the cause, for every domain.
 *
 * Everything below resolves through the PACKAGE NAME, not a relative path, so
 * this file's program is built the way a consumer's is.
 *
 * Checked by `bun run types:check`.
 */
import type { GoodVibesConfig } from '@pellux/goodvibes-sdk/platform/config';

type ConfigKey = keyof GoodVibesConfig;

/** `'present'` when `K` is a key of the merged config, `'ABSENT'` when it is not. */
type Presence<K extends string> = K extends ConfigKey ? 'present' : 'ABSENT';

/**
 * Every key contributed by a `declare module` block in
 * packages/sdk/src/platform/config/schema-domain-*.ts. Adding a domain without
 * adding its side-effect import to schema.ts fails here once its key is listed.
 */
export const clusterPresent: Presence<'cluster'> = 'present';
export const conversationGatePresent: Presence<'conversationGate'> = 'present';
export const devicePresent: Presence<'device'> = 'present';
export const agentsPresent: Presence<'agents'> = 'present';
export const fetchPresent: Presence<'fetch'> = 'present';
export const integrationsPresent: Presence<'integrations'> = 'present';
export const policyPresent: Presence<'policy'> = 'present';
export const securityPresent: Presence<'security'> = 'present';
export const fleetPresent: Presence<'fleet'> = 'present';
export const learningPresent: Presence<'learning'> = 'present';
export const memoryPresent: Presence<'memory'> = 'present';
export const powerPresent: Presence<'power'> = 'present';
export const pushPresent: Presence<'push'> = 'present';
export const worktreePresent: Presence<'worktree'> = 'present';
export const updatePresent: Presence<'update'> = 'present';
export const voicePresent: Presence<'voice'> = 'present';
/**
 * The owner-profile domain is the thirteenth and arrived without a side-effect
 * import, so `DEFAULT_CONFIG.profile` did not typecheck from a consumer's
 * vantage point even though the section, its defaults and its settings rows
 * all ship.
 */
export const profilePresent: Presence<'profile'> = 'present';
/**
 * `checkin` is the same defect from the other direction: its four keys were in
 * `ConfigKey` and its defaults in `DEFAULT_CONFIG`, but no `declare module`
 * block ever put the SECTION on `GoodVibesConfig` at all, so no side-effect
 * import could have carried it. Now declared in schema-domain-runtime.ts,
 * beside the defaults it already owned.
 */
export const checkinPresent: Presence<'checkin'> = 'present';

/**
 * The proof that `Presence` can still answer NO.
 *
 * Without this, every line above would keep compiling if `ConfigKey` ever
 * widened to `string`, a config type that accepts every key reports full
 * coverage forever, which is the same outcome as reporting none.
 */
export const bogusAbsent: Presence<'thisDomainDoesNotExist'> = 'ABSENT';

/** And the merged type is a real object type, not `any` wearing a name. */
export const categoryAccess: GoodVibesConfig['conversationGate'] = {} as GoodVibesConfig['conversationGate'];
