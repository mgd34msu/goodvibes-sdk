/**
 * Pricing config domain — user-set manual model prices.
 *
 * `pricing.modelPrices` is a record keyed `provider:model`, each entry USD
 * per 1M tokens. A manual price ALWAYS outranks provider-served and catalog
 * pricing in the model pricing resolver (providers/model-pricing.ts) — the
 * owner's negotiated or self-hosted rate is the truth for that deployment.
 * The value is read live on every resolution, so edits apply with no
 * restart. An empty record means no manual prices: models resolve from
 * provider/catalog sources or land on honest UNKNOWN, never $0.
 */

import type { ConfigSetting } from './schema-types.js';
import { validateManualModelPrices } from '../providers/model-pricing.js';

export const pricingConfigDefaults = {
  pricing: {
    modelPrices: {},
  },
};

export const pricingConfigSettings: ConfigSetting[] = [
  {
    key: 'pricing.modelPrices',
    type: 'object',
    default: {},
    description:
      'Manual model prices, keyed provider:model (e.g. "openrouter:deepseek/deepseek-chat"). Each entry: '
      + '{ input, output, cacheRead?, cacheWrite? } in USD per 1M tokens. A manual price always wins over '
      + 'provider-served and catalog pricing and applies live (no restart). Set one when registering a '
      + 'custom provider/model, or to pin a negotiated rate for any model.',
    validate: validateManualModelPrices,
    validationHint: 'record keyed "provider:model" of { input, output, cacheRead?, cacheWrite? } — finite numbers >= 0, USD per 1M tokens',
  },
];
