import type { KnowledgeNodeRecord } from '../types.js';
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
      text: `The source-backed facts I found indicate ${joinFactPhrases(factPhrases)}.`,
    };
  }
  const evidencePhrases = evidence
    .slice(0, mode === 'detailed' ? 8 : mode === 'concise' ? 2 : 5)
    .map(renderEvidencePhrase)
    .filter(Boolean);
  if (evidencePhrases.length > 0) {
    return {
      synthesized: true,
      text: `The indexed evidence currently indicates ${joinFactPhrases(evidencePhrases)}. It does not yet contain enough extracted source-backed facts to answer every part of "${query}".`,
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
  if (value) return `${fact.title}: ${value}`;
  return summary ? `${fact.title}: ${summary}` : fact.title;
}

function joinFactPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join('; ')}; and ${phrases[phrases.length - 1]}`;
}

function renderEvidencePhrase(item: AnswerFallbackEvidence): string {
  const excerpt = normalizeWhitespace(item.excerpt ?? '');
  if (!excerpt) return item.title;
  return `${item.title}: ${clampText(excerpt, 260)}`;
}
