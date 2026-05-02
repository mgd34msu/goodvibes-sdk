import type { KnowledgeNodeRecord } from '../types.js';
import { isLowValueFeatureOrSpecText } from './fact-quality.js';
import { clampText, normalizeWhitespace, readString } from './utils.js';

export interface AnswerFallbackEvidence {
  readonly title: string;
  readonly excerpt?: string;
}

export interface FallbackAnswer {
  readonly text: string;
  readonly synthesized: boolean;
}

export function renderFallbackAnswer(
  query: string,
  mode: string,
  evidence: readonly AnswerFallbackEvidence[],
  facts: readonly KnowledgeNodeRecord[],
): FallbackAnswer {
  const factLimit = mode === 'detailed' ? 12 : mode === 'concise' ? 3 : 8;
  const factPhrases = facts.slice(0, factLimit).map(renderFactPhrase).filter(Boolean);
  if (factPhrases.length > 0) {
    return {
      synthesized: true,
      text: `Available source-backed details include ${joinFactPhrases(factPhrases)}.`,
    };
  }
  const sourceTitles = evidence
    .slice(0, mode === 'detailed' ? 6 : mode === 'concise' ? 2 : 4)
    .map((item) => normalizeWhitespace(item.title))
    .filter(Boolean);
  if (sourceTitles.length > 0) {
    return {
      synthesized: false,
      text: `I found matching sources (${joinFactPhrases(sourceTitles)}), but they have not produced enough source-backed facts to answer "${query}" yet.`,
    };
  }
  return {
    synthesized: false,
    text: `No knowledge matched "${query}".`,
  };
}

function renderFactPhrase(fact: KnowledgeNodeRecord): string {
  const value = readString(fact.metadata.value);
  const summary = fact.summary ?? readString(fact.metadata.evidence);
  const phrase = value ? `${fact.title}: ${value}` : summary ? `${fact.title}: ${summary}` : fact.title;
  const cleaned = normalizeWhitespace(clampText(phrase, 220));
  if (isRawSourceFragment(cleaned)) return '';
  return isLowValueFeatureOrSpecText(cleaned) ? '' : cleaned;
}

function isRawSourceFragment(value: string): boolean {
  const lower = value.toLowerCase();
  return /\bsemantic-gap-repair\b/.test(lower)
    || /\bsource-backed facts identify\b/.test(lower)
    || /\b(manual\.nz|current page|loading)\b/.test(lower)
    || /\b[a-z0-9-]+\.(com|net|org|io|dev|tv|ca)\/[a-z0-9/_?=&.#-]+/.test(lower)
    || /\b[a-z]{2}\/[a-z0-9/_-]+\/[a-z0-9._-]+/.test(lower);
}

function joinFactPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join('; ')}; and ${phrases[phrases.length - 1]}`;
}
