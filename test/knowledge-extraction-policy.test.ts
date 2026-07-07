import { describe, expect, test } from 'bun:test';
import {
  KNOWLEDGE_EXTRACTOR_VERSION,
  knowledgeExtractionNeedsRefresh,
} from '../packages/sdk/src/platform/knowledge/extraction-policy.js';
import type { KnowledgeExtractionRecord } from '../packages/sdk/src/platform/knowledge/types.js';

function extraction(overrides: Partial<KnowledgeExtractionRecord>): KnowledgeExtractionRecord {
  return {
    id: 'extract-test',
    sourceId: 'source-test',
    extractorId: 'pdfjs',
    format: 'pdf',
    sections: [],
    links: [],
    estimatedTokens: 1,
    structure: {},
    // Extractions written by the current pipeline carry the current extractor
    // version, so the text-usefulness policy is what these cases exercise.
    metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('knowledge extraction refresh policy', () => {
  test('does not re-extract useful PDF records solely because they are PDFs', () => {
    expect(knowledgeExtractionNeedsRefresh(extraction({
      summary: 'The LG 86NANO90UNA supports Dolby Vision and HDMI eARC.',
      sections: ['Picture and sound features'],
      structure: {},
    }))).toBe(false);
  });

  test('refreshes limited PDF placeholders and raw PDF payload text', () => {
    expect(knowledgeExtractionNeedsRefresh(extraction({
      extractorId: 'pdf',
      summary: 'PDF extraction produced limited text; OCR is not used in-core.',
      structure: { extractedStringCount: 0 },
    }))).toBe(true);
    expect(knowledgeExtractionNeedsRefresh(extraction({
      extractorId: 'pdf',
      summary: '%PDF-1.7 7 0 obj /Filter /FlateDecode stream raw-binary-payload',
      structure: { searchText: '%PDF-1.7 7 0 obj /Filter /FlateDecode stream raw-binary-payload' },
    }))).toBe(true);
  });

  test('keeps useful structured search text even when summary is sparse', () => {
    expect(knowledgeExtractionNeedsRefresh(extraction({
      summary: 'PDF document.',
      structure: {
        searchText: 'LG 86NANO90UNA specifications include HDR10, Dolby Vision, HDMI eARC, 120 Hz refresh rate, and webOS.',
      },
    }))).toBe(false);
  });

  test('re-extracts a stored capture produced by an older extractor generation (data-lake re-extraction)', () => {
    const useful = extraction({
      summary: 'The LG 86NANO90UNA supports Dolby Vision and HDMI eARC.',
      structure: {},
      metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION },
    });
    // Current generation: usable text, no refresh.
    expect(knowledgeExtractionNeedsRefresh(useful, KNOWLEDGE_EXTRACTOR_VERSION)).toBe(false);
    // An advancing extractor generation re-extracts the retained capture even
    // though its prior text is still usable — the lake's compounding payoff.
    expect(knowledgeExtractionNeedsRefresh(useful, KNOWLEDGE_EXTRACTOR_VERSION + 1)).toBe(true);
    // A legacy extraction with no version stamp is the oldest generation.
    expect(knowledgeExtractionNeedsRefresh(extraction({
      summary: 'Useful legacy text about the display.',
      structure: {},
      metadata: {},
    }), KNOWLEDGE_EXTRACTOR_VERSION)).toBe(true);
  });
});
