import { inflateSync } from 'node:zlib';
import type { KnowledgeExtractionResult } from './extractors.js';
import {
  KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS,
  looksBinaryLikeText,
  looksLikeRawPdfPayload,
} from './extraction-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function searchTextPayload(value: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned || looksBinaryLikeText(cleaned) || looksLikeRawPdfPayload(cleaned)) return undefined;
  return cleaned.length <= KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS
    ? cleaned
    : cleaned.slice(0, KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS);
}

function estimateTokens(...chunks: Array<string | undefined | null>): number {
  const total = chunks
    .filter((value): value is string => typeof value === 'string')
    .reduce((sum, value) => sum + value.length, 0);
  return Math.max(1, Math.ceil(total / 4));
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
}

function summarizeText(text: string, maxLength = 320): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned || looksBinaryLikeText(cleaned) || looksLikeRawPdfPayload(cleaned)) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  const sentence = cleaned.match(/^(.{0,320}?[.!?])(?:\s|$)/)?.[1]?.trim();
  return sentence && sentence.length >= 40 ? sentence : `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function excerptText(text: string, maxLength = 480): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned || looksBinaryLikeText(cleaned) || looksLikeRawPdfPayload(cleaned)) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function uniqueStrings(values: Iterable<string>, limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = cleanText(value);
    if (!trimmed || seen.has(trimmed) || !isReadablePdfText(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

export async function extractPdf(buffer: Buffer): Promise<KnowledgeExtractionResult> {
  const parsed = await extractPdfWithPdfJs(buffer);
  if (parsed) return parsed;
  const raw = extractPdfRawStreams(buffer);
  if (raw) return raw;
  throw new Error('PDF extraction failed: no readable text was extracted. OCR or a dedicated PDF provider may be required.');
}

async function extractPdfWithPdfJs(buffer: Buffer): Promise<KnowledgeExtractionResult | undefined> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    });
    const document = await loadingTask.promise;
    const pageCount = document.numPages;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = textContentItemsToLines(content.items);
      if (lines.length > 0) pageTexts.push(lines.join('\n'));
      page.cleanup();
    }
    await document.destroy();
    const text = cleanText(pageTexts.join('\n\n'));
    if (!text) return undefined;
    const searchText = searchTextPayload(text);
    return {
      extractorId: 'pdfjs',
      format: 'pdf',
      title: firstNonEmptyLine(text) ?? 'PDF document',
      summary: summarizeText(text) ?? 'PDF document.',
      excerpt: excerptText(text),
      sections: uniqueStrings(text.split(/\n+/), 24),
      links: uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s)]+/g), (match) => match[0]), 50),
      estimatedTokens: estimateTokens(text),
      structure: {
        pageCount,
        extractedTextChars: text.length,
        ...(searchText ? { searchText } : {}),
      },
      metadata: {
        limitations: ['PDF text extraction does not perform OCR for scanned images.'],
      },
    };
  } catch (error) {
    logger.debug('PDF extraction: pdfjs path failed; trying raw stream extraction', {
      error: summarizeError(error),
    });
    return undefined;
  }
}

function textContentItemsToLines(items: readonly unknown[]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    const record = unknownRecord(item);
    const text = typeof record.str === 'string' ? cleanText(record.str) : '';
    if (text) current = current ? `${current} ${text}` : text;
    if (record.hasEOL === true && current) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function extractPdfRawStreams(buffer: Buffer): KnowledgeExtractionResult | undefined {
  const body = buffer.toString('latin1');
  const texts: string[] = [];
  const streamRe = /(<<[\s\S]{0,4096}?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(body)) !== null) {
    const dictionary = match[1]! ?? '';
    const rawChunk = match[2]! ?? '';
    const chunk = decodePdfStreamChunk(dictionary, rawChunk);
    for (const text of extractPdfTextStrings(chunk)) {
      if (isReadablePdfText(text)) texts.push(text);
    }
  }
  const combined = uniqueStrings(texts, 64).join('\n');
  const searchable = uniqueStrings(texts, 512).join('\n');
  const searchText = searchTextPayload(searchable);
  if (!searchText) return undefined;
  return {
    extractorId: 'pdf-raw',
    format: 'pdf',
    title: firstNonEmptyLine(combined) ?? 'PDF document',
    summary: summarizeText(combined) ?? 'PDF document text extracted from raw streams.',
    excerpt: excerptText(combined),
    sections: uniqueStrings(combined.split(/\n+/), 8),
    links: uniqueStrings(Array.from(combined.matchAll(/\bhttps?:\/\/[^\s)]+/g), (linkMatch) => linkMatch[0]), 50),
    estimatedTokens: estimateTokens(combined),
    structure: {
      extractedStringCount: texts.length,
      ...(searchText ? { searchText } : {}),
    },
    metadata: {
      limitations: texts.length === 0
        ? ['No readable text streams were found. Complex PDFs need OCR or a dedicated provider.']
        : ['PDF text extraction does not perform OCR for scanned images.'],
    },
  };
}

function decodePdfStreamChunk(dictionary: string, rawChunk: string): string {
  if (!/\/FlateDecode\b/i.test(dictionary)) return rawChunk;
  try {
    return inflateSync(Buffer.from(rawChunk, 'latin1')).toString('latin1');
  } catch (error) {
    logger.debug('PDF extraction: failed to inflate FlateDecode stream', {
      error: summarizeError(error),
    });
    return '';
  }
}

function extractPdfTextStrings(chunk: string): string[] {
  return [
    ...extractLiteralStrings(chunk),
    ...extractHexStrings(chunk),
  ];
}

function extractLiteralStrings(chunk: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] !== '(') {
      index += 1;
      continue;
    }
    const parsed = readPdfLiteralString(chunk, index + 1);
    if (parsed) {
      values.push(cleanText(parsed.value));
      index = parsed.nextIndex;
    } else {
      index += 1;
    }
  }
  return values;
}

function readPdfLiteralString(chunk: string, start: number): { readonly value: string; readonly nextIndex: number } | undefined {
  let depth = 1;
  let escaped = false;
  let value = '';
  for (let index = start; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (escaped) {
      const decoded = decodePdfEscape(char, chunk.slice(index + 1, index + 3));
      value += decoded.value;
      index += decoded.consumed;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      value += char;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return { value, nextIndex: index + 1 };
      value += char;
      continue;
    }
    value += char;
  }
  return undefined;
}

function decodePdfEscape(char: string, following: string): { readonly value: string; readonly consumed: number } {
  switch (char) {
    case 'n':
      return { value: '\n', consumed: 0 };
    case 'r':
      return { value: '\r', consumed: 0 };
    case 't':
      return { value: '\t', consumed: 0 };
    case 'b':
      return { value: '\b', consumed: 0 };
    case 'f':
      return { value: '\f', consumed: 0 };
    case '(':
    case ')':
    case '\\':
      return { value: char, consumed: 0 };
    default:
      if (/[0-7]/.test(char)) {
        const octal = `${char}${(following.match(/^[0-7]{0,2}/)?.[0] ?? '')}`;
        return { value: String.fromCharCode(Number.parseInt(octal, 8)), consumed: octal.length - 1 };
      }
      return { value: char, consumed: 0 };
  }
}

function extractHexStrings(chunk: string): string[] {
  const values: string[] = [];
  const hexRe = /<([0-9A-Fa-f\s]{4,})>/g;
  let match: RegExpExecArray | null;
  while ((match = hexRe.exec(chunk)) !== null) {
    const text = decodeHexPdfString(match[1] ?? '');
    if (text) values.push(cleanText(text));
  }
  return values;
}

function decodeHexPdfString(value: string): string | undefined {
  const hex = value.replace(/\s+/g, '');
  if (hex.length < 4 || hex.length % 2 !== 0) return undefined;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length >= 2 && bytes[0]! === 0xfe && bytes[1]! === 0xff) {
    return decodeUtf16Be(bytes.subarray(2));
  }
  const mostlyUtf16 = bytes.length >= 4 && bytes.filter((byte, index) => index % 2 === 0 && byte === 0).length >= Math.floor(bytes.length / 4);
  if (mostlyUtf16) return decodeUtf16Be(bytes);
  return bytes.toString('latin1');
}

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped.toString('utf16le');
}

function isReadablePdfText(value: string): boolean {
  const text = cleanText(value);
  if (text.length < 2 || looksLikeRawPdfPayload(text) || looksBinaryLikeText(text)) return false;
  const sample = text.slice(0, 512);
  let lettersOrDigits = 0;
  let whitespace = 0;
  for (const char of sample) {
    if (/[a-z0-9]/i.test(char)) lettersOrDigits += 1;
    if (/\s/.test(char)) whitespace += 1;
  }
  return (lettersOrDigits + whitespace) / sample.length >= 0.55;
}
