/**
 * memory-usage-detection.ts — heuristic reference detection (HOISTED to the SDK).
 *
 * Did the model's output plausibly USE an injected memory, or was the memory
 * merely present in the prompt with no detectable trace? Promoted verbatim from
 * the agent surface so every consumer shares the SAME two-tier honest signal.
 *
 * Exactly two tiers:
 *   - 'referenced': the output overlaps this memory's DISTINCTIVE content
 *     (uncommon tokens or a distinctive two-word phrase), so the memory plausibly
 *     mattered to the answer.
 *   - 'present': the memory was injected but nothing in the output distinctively
 *     overlaps it.
 *
 * It is NOT a relevance score and NOT ground truth — distinctive-token overlap
 * can be coincidental, and a memory can influence an answer without lexical
 * overlap. Everywhere this signal is shown it must be labelled as heuristic
 * overlap (see MEMORY_USAGE_SIGNAL_NOTE). The bar requires either two distinctive
 * tokens, one long distinctive token, or a distinctive adjacent phrase, so common
 * words alone never count as a reference.
 */
export type MemoryReferenceTier = 'referenced' | 'present';

export interface MemoryReferenceInput {
  readonly id: string;
  readonly summary: string;
  readonly detail?: string | undefined;
}

export interface MemoryReferenceResult {
  readonly referenced: readonly string[];
  readonly present: readonly string[];
  readonly perId: ReadonlyMap<string, MemoryReferenceTier>;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'was', 'were',
  'has', 'have', 'had', 'will', 'shall', 'when', 'then', 'than', 'they', 'them', 'their', 'there',
  'here', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why', 'not', 'but', 'all', 'any', 'can',
  'use', 'used', 'using', 'via', 'per', 'about', 'over', 'under', 'also', 'only', 'each', 'some',
  'such', 'more', 'most', 'less', 'least', 'been', 'being', 'does', 'done', 'should', 'would', 'could',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
}

function distinctiveTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 4 || STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function distinctivePhrases(text: string): string[] {
  const tokens = tokenize(text).filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  const phrases: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
  return phrases;
}

function classify(record: MemoryReferenceInput, responseTokens: ReadonlySet<string>, normalizedResponse: string): MemoryReferenceTier {
  const source = `${record.summary} ${record.detail ?? ''}`;
  const tokens = distinctiveTokens(source);
  if (tokens.length === 0) return 'present';

  let overlap = 0;
  let longOverlap = false;
  for (const token of tokens) {
    if (responseTokens.has(token)) {
      overlap += 1;
      if (token.length >= 6) longOverlap = true;
    }
  }
  if (overlap >= 2) return 'referenced';
  if (overlap === 1 && longOverlap) return 'referenced';

  for (const phrase of distinctivePhrases(source)) {
    if (normalizedResponse.includes(phrase)) return 'referenced';
  }
  return 'present';
}

export function detectReferencedMemoryIds(
  responseText: string,
  records: readonly MemoryReferenceInput[],
): MemoryReferenceResult {
  const responseTokens = new Set(tokenize(responseText).filter((token) => token.length >= 4));
  const normalizedResponse = tokenize(responseText).join(' ');
  const referenced: string[] = [];
  const present: string[] = [];
  const perId = new Map<string, MemoryReferenceTier>();
  for (const record of records) {
    const tier = classify(record, responseTokens, normalizedResponse);
    perId.set(record.id, tier);
    if (tier === 'referenced') referenced.push(record.id);
    else present.push(record.id);
  }
  return { referenced, present, perId };
}
