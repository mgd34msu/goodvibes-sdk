import { describe, expect, test } from 'bun:test';
import {
  knowledgeExtractionNeedsRefresh,
} from '../packages/sdk/src/_internal/platform/knowledge/extraction-policy.js';
import type { KnowledgeExtractionRecord } from '../packages/sdk/src/_internal/platform/knowledge/types.js';

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
    metadata: {},
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
});
