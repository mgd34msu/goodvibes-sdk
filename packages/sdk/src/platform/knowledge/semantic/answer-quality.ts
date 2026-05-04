import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { hasConcreteFeatureSignal, isLowValueFeatureOrSpecText, semanticFactText } from './fact-quality.js';
import { readStringArray, splitSentences } from './utils.js';

export interface CleanSynthesizedAnswerOptions {
  readonly fallbackText?: string | undefined;
}

export function answerNeedsFeatureGap(input: {
  readonly query: string;
  readonly text?: string | undefined;
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
}): boolean {
  if (input.linkedObjects.length === 0) return false;
  const linkedObjectIds = new Set(input.linkedObjects.map((node) => node.id));
  const concreteFactCount = input.facts.filter((fact) => {
    const text = semanticFactText(fact);
    return factLinksToAnswerObject(fact, linkedObjectIds)
      && hasConcreteFeatureSignal(text)
      && !isLowValueFeatureOrSpecText(text);
  }).length;
  if (concreteFactCount >= 3) return false;
  const broadQuery = hasBroadFeatureQueryIntent(input.query);
  if (!broadQuery && concreteFactCount >= 2 && input.text && hasEnoughAnswerSignal(input.query, input.text)) return false;
  const sourceText = input.sources.map((source) => `${source.title} ${source.summary ?? ''} ${source.tags.join(' ')}`).join('\n');
  const answerText = `${input.text ?? ''}\n${sourceText}`;
  if (!broadQuery
    && /manual|specification|product|datasheet|support|source-backed|official-vendor-domain|manufacturer-domain/i.test(answerText)
    && concreteFactCount >= 2) {
    return false;
  }
  return true;
}

export function cleanSynthesizedAnswer(
  text: string,
  featureIntent: boolean,
  options: CleanSynthesizedAnswerOptions = {},
): string {
  if (!featureIntent) return text;
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const cleanedBlocks = blocks.map((block) => {
    const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
    const kept = lines.filter((line) => !isLowValueFeatureOrSpecText(line));
    if (kept.length > 0 && kept.length < lines.length) return kept.join('\n');
    if (lines.length > 1) return kept.join('\n');
    const sentences = splitSentences(block, 600);
    const keptSentences = sentences.filter((sentence) => !isLowValueFeatureOrSpecText(sentence));
    return keptSentences.length > 0 && keptSentences.length < sentences.length
      ? keptSentences.join(' ')
      : block;
  }).filter(Boolean);
  return cleanedBlocks.length > 0
    ? cleanedBlocks.join('\n\n')
    : options.fallbackText ?? '';
}

function factLinksToAnswerObject(fact: KnowledgeNodeRecord, linkedObjectIds: ReadonlySet<string>): boolean {
  if (linkedObjectIds.size === 0) return true;
  const ids = [
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ];
  return ids.some((id) => linkedObjectIds.has(id));
}

function hasEnoughAnswerSignal(query: string, text: string): boolean {
  if (isLowValueFeatureOrSpecText(text) || !hasConcreteFeatureSignal(text)) return false;
  const broadQuery = hasBroadFeatureQueryIntent(query);
  if (broadQuery) return featureSignalFamilyCount(text) >= 3;
  return queryFeatureTerms(query).some((term) => text.toLowerCase().includes(term));
}

function hasBroadFeatureQueryIntent(query: string): boolean {
  return /\b(features?|specs?|specifications?|capabilities|what can|what does .* have)\b/i.test(query);
}

function queryFeatureTerms(query: string): string[] {
  return Array.from(query.toLowerCase().matchAll(
    /\b(hdmi(?:\s*2\.1)?|usb|hdr10?|dolby vision|dolby|earc|arc|bluetooth|wi-?fi|ethernet|remote|refresh|120\s*hz|60\s*hz|ports?|speakers?|audio|apps?|airplay|homekit|tuner|atsc|qam|gaming|game|vrr|allm)\b/g,
  )).map((match) => match[1]!.replace(/\s+/g, ' '));
}

function featureSignalFamilyCount(text: string): number {
  const lower = text.toLowerCase();
  return [
    /\b(hdmi|earc|arc|ports?|usb|ethernet)\b/,
    /\b(hdr|hdr10|dolby vision|hlg|filmmaker)\b/,
    /\b(4k|8k|uhd|resolution|refresh|120\s*hz|60\s*hz|display|screen|panel)\b/,
    /\b(webos|apps?|streaming|airplay|homekit|chromecast|smart tv)\b/,
    /\b(wi-?fi|bluetooth|wireless lan)\b/,
    /\b(audio|speakers?|dolby atmos|sound)\b/,
    /\b(game|gaming|vrr|allm|freesync|g-sync)\b/,
    /\b(tuner|atsc|qam|ntsc|broadcast)\b/,
  ].filter((pattern) => pattern.test(lower)).length;
}
