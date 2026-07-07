import type { KnowledgeExtractionRecord } from './types.js';

/**
 * The current extractor generation. Stamped onto every extraction's metadata at
 * write time (`extractorVersion`). Bump this when the extraction pipeline improves
 * so that the retained raw-artifact lake is re-processed: an extraction produced by
 * an older generation is treated as stale-by-version and re-extracted from its
 * stored artifact, even when its prior text was non-empty. This is what turns the
 * retained lake into a compounding asset. Extractions written before versioning
 * carry no stamp and resolve to version 0, so they re-extract once.
 */
export const KNOWLEDGE_EXTRACTOR_VERSION = 1;

export function readKnowledgeExtractorVersion(metadata: Record<string, unknown>): number {
  const value = metadata.extractorVersion;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS = 128 * 1024;

export const KNOWLEDGE_MIN_BINARY_SAMPLE_CHARS = 120;
export const KNOWLEDGE_BINARY_SAMPLE_CHARS = 4_096;
export const KNOWLEDGE_BINARY_EXTENDED_RATIO_THRESHOLD = 0.18;
export const KNOWLEDGE_BINARY_USEFUL_RATIO_THRESHOLD = 0.78;
export const KNOWLEDGE_BINARY_PUNCTUATION_RATIO_THRESHOLD = 0.42;
export const KNOWLEDGE_BINARY_WHITESPACE_RATIO_THRESHOLD = 0.08;

const LIMITED_EXTRACTION_MARKERS = [
  'pdf extraction produced limited text',
  'no readable text streams',
  'no specialized extractor matched',
  'has no specialized in-core extractor',
];

export function knowledgeExtractionNeedsRefresh(
  extraction: KnowledgeExtractionRecord | null,
  currentExtractorVersion: number = KNOWLEDGE_EXTRACTOR_VERSION,
): boolean {
  if (!extraction) return true;
  // Improved-extractor gate: re-extract a stored capture when it was produced by
  // an older extractor generation, even if its prior text was usable.
  if (readKnowledgeExtractorVersion(extraction.metadata) < currentExtractorVersion) return true;
  const searchText = readKnowledgeSearchText(extraction.structure) ?? readKnowledgeSearchText(extraction.metadata);
  if (searchText) return false;
  if (
    hasUsefulKnowledgeExtractionText(extraction.excerpt)
    || hasUsefulKnowledgeExtractionText(extraction.summary)
    || extraction.sections.some(hasUsefulKnowledgeExtractionText)
  ) {
    return false;
  }
  return true;
}

export function readKnowledgeSearchText(record: Record<string, unknown>): string | undefined {
  const value = record.searchText ?? record.text ?? record.content;
  return typeof value === 'string' && hasUsefulKnowledgeExtractionText(value) ? value : undefined;
}

export function hasUsefulKnowledgeExtractionText(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const normalized = value.toLowerCase();
  if (LIMITED_EXTRACTION_MARKERS.some((marker) => normalized.includes(marker))) return false;
  return !looksLikeRawPdfPayload(value) && !looksBinaryLikeText(value);
}

export function looksLikeRawPdfPayload(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('%pdf')
    || /\b\d+\s+\d+\s+obj\b/.test(lower)
    || (lower.includes(' endobj') && lower.includes(' stream'))
    || (lower.includes('/filter') && lower.includes('/flatedecode'));
}

export function looksBinaryLikeText(value: string): boolean {
  const sample = value.slice(0, KNOWLEDGE_BINARY_SAMPLE_CHARS);
  if (sample.length < KNOWLEDGE_MIN_BINARY_SAMPLE_CHARS) return false;
  let control = 0;
  let extended = 0;
  let letters = 0;
  let whitespace = 0;
  let punctuation = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if ((code < 32 && char !== '\n' && char !== '\r' && char !== '\t') || code === 65533) control += 1;
    if (code > 126) extended += 1;
    if (/[a-z0-9]/i.test(char)) letters += 1;
    if (/\s/.test(char)) whitespace += 1;
    if (/[^a-z0-9\s]/i.test(char)) punctuation += 1;
  }
  const length = sample.length;
  const extendedRatio = extended / length;
  const usefulRatio = (letters + whitespace) / length;
  const punctuationRatio = punctuation / length;
  return control > 0
    || (
      extendedRatio > KNOWLEDGE_BINARY_EXTENDED_RATIO_THRESHOLD
      && usefulRatio < KNOWLEDGE_BINARY_USEFUL_RATIO_THRESHOLD
    )
    || (
      punctuationRatio > KNOWLEDGE_BINARY_PUNCTUATION_RATIO_THRESHOLD
      && whitespace / length < KNOWLEDGE_BINARY_WHITESPACE_RATIO_THRESHOLD
    );
}
