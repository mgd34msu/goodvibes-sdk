/**
 * Shared bare model ID resolver — the single place every user-facing entry
 * site routes through so a bare id like `claude-fable-5` "just works"
 * instead of requiring the `provider:model` registryKey format.
 *
 * Behavioral contract (owner-driven, from the live incident that produced
 * this item): a typed model reference resolves in this order —
 *   1. Already provider-qualified (`provider:model`) — pass through unchanged.
 *      Storage stays provider-qualified; this is an input-resolution layer only.
 *   2. Provider already known from context (e.g. the request already carries
 *      a provider field) and that provider has this bare id — qualify to it.
 *   3. Unique across the whole registry (exactly one provider has this bare
 *      id) — auto-qualify to it.
 *   4. Ambiguous (more than one provider has this bare id) — error listing
 *      the actual candidate registryKeys, never a generic format lecture.
 *   5. Unknown (no provider has this bare id) — closest-match suggestions
 *      by edit distance, plus a concrete valid example from the live
 *      registry.
 *
 * Every error produced here names real, currently-registered models —
 * the old "Model lookup requires a provider-qualified registryKey" class of
 * message (which taught the format but gave no example) is retired in favor
 * of one shared, example-carrying resolver.
 */

export interface ModelIdCandidate {
  readonly id: string;
  readonly provider: string;
  readonly registryKey: string;
}

export interface ModelIdResolutionOptions {
  /** A provider already known from context — tried before the registry-wide rules. */
  readonly contextProviderId?: string | undefined;
  /** Max closest-match suggestions to include in an "unknown model" error. Default 3. */
  readonly maxSuggestions?: number | undefined;
}

/**
 * Resolve a user-typed model reference against the live registry's
 * candidate list. Returns the resolved provider-qualified registryKey, or
 * throws an Error carrying a concrete example / the real candidate list /
 * closest-match suggestions — never the old abstract format lecture.
 *
 * @param input - What the user typed: a bare model id or a `provider:model` registryKey.
 * @param candidates - The live registry's models (id/provider/registryKey), e.g. from `ProviderRegistry.listModels()`.
 * @param options - Optional provider-in-context hint and suggestion count.
 */
export function resolveModelReference(
  input: string,
  candidates: readonly ModelIdCandidate[],
  options: ModelIdResolutionOptions = {},
): string {
  const trimmed = input.trim();

  // Rule 1: already provider-qualified — pass through unchanged. Storage
  // stays provider-qualified; downstream lookups report "not found" if the
  // qualified key doesn't actually exist (unchanged behavior, this layer
  // only resolves BARE ids).
  if (trimmed.includes(':')) return trimmed;

  // Rule 2: provider already known from context.
  if (options.contextProviderId) {
    const contextMatch = candidates.find(
      (candidate) => candidate.provider === options.contextProviderId && candidate.id === trimmed,
    );
    if (contextMatch) return contextMatch.registryKey;
  }

  const matches = candidates.filter((candidate) => candidate.id === trimmed);

  // Rule 3: unique across the registry.
  if (matches.length === 1) return matches[0]!.registryKey;

  // Rule 4: ambiguous.
  if (matches.length > 1) {
    const registryKeys = matches.map((candidate) => candidate.registryKey).sort((a, b) => a.localeCompare(b));
    throw new Error(
      `Model id '${trimmed}' is ambiguous — it is available on multiple providers: ${registryKeys.join(', ')}. ` +
        `Specify one explicitly, e.g. '${registryKeys[0]}'.`,
    );
  }

  // Rule 5: unknown — closest-match suggestions plus a concrete valid example.
  throw new Error(buildUnknownModelMessage(trimmed, candidates, options.maxSuggestions ?? 3));
}

function buildUnknownModelMessage(
  input: string,
  candidates: readonly ModelIdCandidate[],
  maxSuggestions: number,
): string {
  const uniqueIds = [...new Set(candidates.map((candidate) => candidate.id))];
  const closestIds = findClosestModelIds(input, uniqueIds, maxSuggestions);
  const suggestionKeys = closestIds
    .map((id) => candidates.find((candidate) => candidate.id === id)?.registryKey)
    .filter((key): key is string => key !== undefined);

  const example = suggestionKeys[0] ?? candidates[0]?.registryKey;

  const parts = [`Unknown model '${input}'.`];
  if (suggestionKeys.length > 0) parts.push(`Did you mean: ${suggestionKeys.join(', ')}?`);
  if (example) parts.push(`Example of a valid model reference: '${example}'.`);
  return parts.join(' ');
}

/**
 * Resolve the CONFIGURED model (the `provider.model` key) through the shared
 * resolver, wrapping any failure with the accepted forms plus a concrete
 * valid example — never the retired abstract format lecture. Unique bare ids
 * auto-qualify; ambiguous ids list their real candidate registryKeys;
 * unknown ids carry closest-match suggestions.
 */
export function resolveConfiguredModelKey(
  configured: string,
  candidates: readonly ModelIdCandidate[],
): string {
  try {
    return resolveModelReference(configured, candidates);
  } catch (error) {
    throw new Error(
      `provider.model '${configured}' could not be resolved: ${error instanceof Error ? error.message : String(error)} ` +
        `Accepted forms: a provider-qualified registryKey (e.g. '${candidates[0]?.registryKey ?? 'openrouter:openrouter/free'}') or a bare model id that is unique across registered providers.`,
    );
  }
}

/**
 * Closest model ids by Levenshtein edit distance, nearest first. No fuzzy-
 * match helper existed anywhere in the SDK before this — this is that small
 * new function, scoped to model-id "did you mean" suggestions.
 */
export function findClosestModelIds(input: string, candidateIds: readonly string[], limit = 3): string[] {
  const target = input.toLowerCase();
  return [...candidateIds]
    .map((id) => ({ id, distance: levenshteinDistance(target, id.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Classic O(n*m) edit-distance DP. Inputs here are short model ids, so this stays cheap. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          previousRow[j]! + 1, // deletion
          currentRow[j - 1]! + 1, // insertion
          previousRow[j - 1]! + cost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length]!;
}
