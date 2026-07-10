/**
 * method-catalog-cost.ts
 *
 * The cost.attribution.get + quota.fanout.get descriptors. A cost view over the
 * platform's existing LLM usage records (per agent/tool/hook/MCP/model/provider/
 * session, cache-aware, 24h/7d windows) and a pre-fan-out quota-window warning
 * grounded in observed rate-limit signals. Both are ws-only invoke verbs (no
 * REST binding, so no gateway-rest-routes parity entry needed), registered from
 * the same composition root that wires ci/checkin (routes/register-gateway-verb-
 * groups.ts) over the runtime bus. Handlers: routes/cost.ts.
 */

import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  COST_ATTRIBUTION_GET_INPUT_SCHEMA,
  COST_ATTRIBUTION_GET_OUTPUT_SCHEMA,
  QUOTA_FANOUT_GET_INPUT_SCHEMA,
  QUOTA_FANOUT_GET_OUTPUT_SCHEMA,
} from './operator-contract-schemas-telemetry.js';

export const builtinGatewayCostMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'cost.attribution.get',
    title: 'Get Cost Attribution',
    description: 'Return windowed (24h/7d) cost attribution over observed LLM usage, grouped by a dimension (agent, tool, hook, mcp, model, provider, session), with cache-aware pricing (fresh input vs cache-read vs cache-write). Honest-unpriced: an unknown model contributes to unpricedRecordCount with a null cost, never a fabricated amount; costState is priced, unpriced, or estimated (a mix). totalCostUsd is null when every contributor is unpriced.',
    category: 'cost',
    scopes: ['read:telemetry'],
    transport: ['ws'],
    inputSchema: COST_ATTRIBUTION_GET_INPUT_SCHEMA,
    outputSchema: COST_ATTRIBUTION_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'quota.fanout.get',
    title: 'Assess Fan-out Against Quota Window',
    description: 'Assess whether spawning N agents against a provider likely exhausts its quota window right now, grounded in observed rate-limit signals (429 retry-after, and limit/remaining when headers carry them). verdict is likely-exhausts (with the evidence it rests on — an active cooldown or an observed remaining below the fan-out), unlikely (with the evidence), or unknown when no signal has been observed — never a fabricated certainty.',
    category: 'quota',
    scopes: ['read:telemetry'],
    transport: ['ws'],
    inputSchema: QUOTA_FANOUT_GET_INPUT_SCHEMA,
    outputSchema: QUOTA_FANOUT_GET_OUTPUT_SCHEMA,
  }),
];
