import type { KnowledgeNodeRecord } from '../types.js';
import {
  readString,
  tokenizeSemanticQuery,
} from './utils.js';
import {
  hasConcreteFeatureSignal,
  isLowValueFeatureOrSpecText,
  semanticFactText,
} from './fact-quality.js';
import { GENERIC_ANSWER_INTENT_TOKENS } from './answer-common.js';

export function filterFactsForQuery(query: string, facts: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const tokens = tokenizeSemanticQuery(query);
  const intent = factIntent(tokens);
  const matching = intent
    ? facts.filter((fact) => intent.has(readString(fact.metadata.factKind) ?? 'note'))
    : [...facts];
  return matching
    .filter((fact) => fact.status !== 'stale' && !isLowValueFactForQuery(tokens, intent, fact))
    .sort(compareFactQuality);
}

export function factIntent(tokens: readonly string[]): ReadonlySet<string> | null {
  const tokenSet = new Set(tokens);
  if (hasAny(tokenSet, ['feature', 'features', 'capability', 'capabilities', 'function', 'functions', 'support', 'supports', 'spec', 'specs', 'specification', 'specifications'])) {
    return new Set(['feature', 'capability', 'specification', 'compatibility', 'configuration', 'identity']);
  }
  if (hasAny(tokenSet, ['reset', 'setup', 'install', 'configure', 'pair'])) {
    return new Set(['procedure', 'configuration', 'troubleshooting']);
  }
  if (hasAny(tokenSet, ['battery', 'filter', 'maintenance', 'warranty', 'replace', 'clean'])) {
    return new Set(['maintenance', 'specification', 'warning']);
  }
  if (hasAny(tokenSet, ['warning', 'caution', 'risk', 'hazard'])) return new Set(['warning']);
  return null;
}

export function hasAny(values: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function isLowValueFactForQuery(
  tokens: readonly string[],
  intent: ReadonlySet<string> | null,
  fact: KnowledgeNodeRecord,
): boolean {
  if (!intent || !hasFeatureIntent(intent)) return false;
  const kind = readString(fact.metadata.factKind) ?? 'note';
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration', 'identity'].includes(kind)) return false;
  const text = semanticFactText(fact);
  if (isLowValueFeatureOrSpecText(text)) return true;
  if (!hasConcreteFeatureSignal(text)) return true;
  const extractor = readString(fact.metadata.extractor);
  const confidence = typeof fact.confidence === 'number' ? fact.confidence : 0;
  if (extractor !== 'deterministic' || confidence > 60) return false;
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  return subjectTokens.length > 0 && !hasConcreteFeatureSignal(text);
}

export function hasFeatureIntent(intent: ReadonlySet<string>): boolean {
  return intent.has('feature') || intent.has('capability') || intent.has('specification') || intent.has('compatibility');
}

export function hasFeatureIntentForQuery(query: string): boolean {
  const intent = factIntent(tokenizeSemanticQuery(query));
  return Boolean(intent && hasFeatureIntent(intent));
}

function compareFactQuality(left: KnowledgeNodeRecord, right: KnowledgeNodeRecord): number {
  return factQuality(right) - factQuality(left) || left.title.localeCompare(right.title);
}

function factQuality(fact: KnowledgeNodeRecord): number {
  const extractor = readString(fact.metadata.extractor);
  const kind = readString(fact.metadata.factKind);
  const value = readString(fact.metadata.value);
  const authority = readString(fact.metadata.sourceAuthority);
  return (extractor === 'llm' ? 40 : 0)
    + (extractor === 'repair-promotion' ? 34 : 0)
    + (authority === 'official-vendor' ? 24 : authority === 'vendor' ? 14 : 0)
    + (value ? 12 : 0)
    + (kind === 'capability' || kind === 'feature' ? 8 : kind === 'specification' ? 6 : 0)
    + Math.round(fact.confidence / 10);
}

export function renderFactForScoring(fact: KnowledgeNodeRecord): string {
  const evidence = cleanFactEvidenceForAnswer(fact);
  return [
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    evidence,
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ].filter(Boolean).join(' ');
}

export function renderFactForPrompt(fact: KnowledgeNodeRecord): string {
  const kind = readString(fact.metadata.factKind) ?? 'fact';
  const value = readString(fact.metadata.value);
  const evidence = cleanFactEvidenceForAnswer(fact);
  return `${kind}: ${fact.title}${value ? ` = ${value}` : ''}${fact.summary ? ` - ${fact.summary}` : ''}${evidence ? ` Evidence: ${evidence}` : ''}`;
}

function cleanFactEvidenceForAnswer(fact: KnowledgeNodeRecord): string | undefined {
  const evidence = readString(fact.metadata.evidence)?.replace(/\s+/g, ' ').trim() ?? '';
  if (!evidence) return undefined;
  if (isLowValueFeatureOrSpecText(evidence)) return undefined;
  const normalizedEvidence = normalizeFactText(evidence);
  if (!normalizedEvidence) return undefined;
  const title = normalizeFactText(fact.title);
  const summary = normalizeFactText(fact.summary ?? '');
  const value = normalizeFactText(readString(fact.metadata.value) ?? '');
  if (normalizedEvidence === title || normalizedEvidence === summary || normalizedEvidence === value) return undefined;
  if (title && value && normalizedEvidence.includes(title) && normalizedEvidence.includes(value)) return undefined;
  return evidence;
}

function normalizeFactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function renderNodeEvidence(node: KnowledgeNodeRecord): string {
  if (node.metadata.semanticKind === 'fact') return renderFactForPrompt(node);
  if (node.metadata.semanticKind === 'wiki_page') return readString(node.metadata.markdown) ?? node.summary ?? '';
  return [node.summary, node.aliases.join(', ')].filter(Boolean).join('\n');
}

export function semanticKindBoost(node: KnowledgeNodeRecord): number {
  if (node.metadata.semanticKind === 'fact') return 45;
  if (node.metadata.semanticKind === 'wiki_page') return 24;
  if (node.metadata.semanticKind === 'entity') return 18;
  return 0;
}
