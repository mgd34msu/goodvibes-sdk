/**
 * Compile-time pin: RuntimeFoundationClientsOptions.runtimeServices is the
 * NARROW published slice, not the entire internal RuntimeServices — an
 * external fork that composes its own runtime services can construct the
 * options from a minimal object literal WITHOUT fabricating unexported
 * internals (memory governor, cache registry, pause controller, schedulers).
 *
 * The literal below lists exactly the slice's keys: if the type ever widens
 * back to full RuntimeServices this file fails to compile (missing
 * properties), and if the slice gains/loses keys the literal pins the drift
 * (excess-property checking).
 *
 * Checked by `bun run types:check` (tsc over test/types/**), resolving
 * through the package name so the exports map is exercised too.
 */
import type { bootstrap } from '@pellux/goodvibes-sdk/platform/runtime';
// The memory-governance subpath must serve TYPES through the package name
// (the phantom-export fix this file rides with).
import type {
  MemoryGovernorConfig,
  MemoryGovernorSnapshot,
  MemoryTier,
  RegisteredCache,
} from '@pellux/goodvibes-sdk/platform/runtime/memory';

type Options = bootstrap.RuntimeFoundationClientsOptions;
type Slice = bootstrap.RuntimeFoundationServicesSlice;

declare function stub<T>(): T;

// Exactly the published slice — no memoryGovernor / cacheRegistry /
// pauseController and none of the rest of the internal composition.
const runtimeServices: Slice = {
  runtimeBus: stub<Slice['runtimeBus']>(),
  shellPaths: stub<Slice['shellPaths']>(),
  runtimeStore: stub<Slice['runtimeStore']>(),
  sessionBroker: stub<Slice['sessionBroker']>(),
  approvalBroker: stub<Slice['approvalBroker']>(),
  providerRegistry: stub<Slice['providerRegistry']>(),
  serviceRegistry: stub<Slice['serviceRegistry']>(),
  subscriptionManager: stub<Slice['subscriptionManager']>(),
  secretsManager: stub<Slice['secretsManager']>(),
  distributedRuntime: stub<Slice['distributedRuntime']>(),
  remoteRunnerRegistry: stub<Slice['remoteRunnerRegistry']>(),
  remoteSupervisor: stub<Slice['remoteSupervisor']>(),
  benchmarkStore: stub<Slice['benchmarkStore']>(),
  favoritesStore: stub<Slice['favoritesStore']>(),
  knowledgeService: stub<Slice['knowledgeService']>(),
  memoryRegistry: stub<Slice['memoryRegistry']>(),
  codeIndexStore: stub<Slice['codeIndexStore']>(),
  hookDispatcher: stub<Slice['hookDispatcher']>(),
  hookWorkbench: stub<Slice['hookWorkbench']>(),
  mcpRegistry: stub<Slice['mcpRegistry']>(),
};

// The full options construct from that minimal literal.
const options: Options = {
  runtimeServices,
  tasksReadModel: stub<Options['tasksReadModel']>(),
  taskManager: stub<Options['taskManager']>(),
};

// The memory subpath's composer-facing types are usable standalone.
const config: MemoryGovernorConfig = {
  budgetMb: 0,
  elevatedPct: 60,
  highPct: 80,
  criticalPct: 95,
  tripwireRateMbPerSec: 25,
  tripwireSustainSec: 60,
  hardLimitPct: 90,
};
declare const snapshot: MemoryGovernorSnapshot;
const tier: MemoryTier = snapshot.tier;
declare const cache: RegisteredCache;

export { options, config, tier, cache };
