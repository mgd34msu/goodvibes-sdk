/**
 * model-picker-provider-filter.ts — the two-group ordering a model picker
 * shows over a provider list: a small "popular" group first, then everything
 * else, each alphabetized.
 *
 * The popular set is a curated display convenience, not a capability
 * statement: membership only decides which group a provider is listed under.
 * A provider absent from it is equally usable — it simply sorts into the
 * second group.
 */

/**
 * Provider ids surfaced in the picker's first group. Compared against
 * lower-cased provider ids, so callers may pass ids in any casing.
 */
export const POPULAR_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'google',
  'groq',
  'mistral',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
  'synthetic',
]);

/**
 * Split `providers` into the popular group and everything else, alphabetizing
 * each group independently. Input order is not preserved.
 */
export function groupProviders(providers: readonly string[]): { popular: string[]; all: string[] } {
  const popular: string[] = [];
  const all: string[] = [];

  for (const provider of providers) {
    if (POPULAR_PROVIDERS.has(provider.toLowerCase())) {
      popular.push(provider);
    } else {
      all.push(provider);
    }
  }

  popular.sort((a, b) => a.localeCompare(b));
  all.sort((a, b) => a.localeCompare(b));

  return { popular, all };
}

/**
 * Group `providers` as above, flatten to popular-then-rest order, and keep
 * only the entries whose id contains `query` (case-insensitive substring).
 * An empty or whitespace-only query returns the full ordered list.
 */
export function filterProviders(providers: readonly string[], query: string): string[] {
  const { popular, all } = groupProviders(providers);
  const ordered = [...popular, ...all];
  const normalized = query.trim().toLowerCase();
  return normalized.length === 0
    ? ordered
    : ordered.filter((provider) => provider.toLowerCase().includes(normalized));
}
