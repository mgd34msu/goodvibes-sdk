/**
 * memory-record-body.ts — request-body parsers for the daemon-owned memory record
 * routes (add / search / update-review).
 *
 * These build the loose, wire-shaped input objects the route handlers hand to the
 * memory registry. Validation is honest but forgiving of extra fields: required
 * fields missing → 400 with a stated reason; unknown enum-ish values are passed
 * through for the store to normalize (the store already clamps confidence and
 * normalizes scope/reviewState), never silently dropped.
 */

import { jsonErrorResponse } from './error-response.js';
import { isJsonRecord, readOptionalStringField, readStringArrayField, type JsonRecord } from './route-helpers.js';
import type {
  MemoryProvenanceLinkInput,
  MemoryRecordAddInput,
  MemoryRecordReviewInput,
  MemoryRecordSearchFilterInput,
} from './integration-route-types.js';

function readOptionalNumberField(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalBooleanField(body: JsonRecord, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Parse a provenance link array: each entry needs kind+ref; label is optional. Invalid entries are skipped. */
function readProvenanceField(body: JsonRecord, max = 64): readonly MemoryProvenanceLinkInput[] | undefined {
  const value = body.provenance;
  if (!Array.isArray(value)) return undefined;
  const output: MemoryProvenanceLinkInput[] = [];
  for (let index = 0; index < value.length && index < max; index++) {
    const entry = value[index];
    if (!isJsonRecord(entry)) continue;
    const kind = readOptionalStringField(entry, 'kind');
    const ref = readOptionalStringField(entry, 'ref');
    if (!kind || !ref) continue;
    const label = readOptionalStringField(entry, 'label');
    output.push({ kind, ref, ...(label ? { label } : {}) });
  }
  return output.length > 0 ? output : undefined;
}

function readReviewField(body: JsonRecord): MemoryRecordAddInput['review'] | undefined {
  const value = body.review;
  if (!isJsonRecord(value)) return undefined;
  const state = readOptionalStringField(value, 'state');
  const confidence = readOptionalNumberField(value, 'confidence');
  const reviewedBy = readOptionalStringField(value, 'reviewedBy');
  const staleReason = readOptionalStringField(value, 'staleReason');
  if (state === undefined && confidence === undefined && reviewedBy === undefined && staleReason === undefined) {
    return undefined;
  }
  return {
    ...(state ? { state } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reviewedBy ? { reviewedBy } : {}),
    ...(staleReason ? { staleReason } : {}),
  };
}

/** Parse POST /api/memory/records — cls and summary are required. */
export function parseMemoryRecordAddBody(body: JsonRecord): MemoryRecordAddInput | Response {
  const cls = readOptionalStringField(body, 'cls');
  const summary = readOptionalStringField(body, 'summary');
  if (!cls) return jsonErrorResponse({ error: 'Missing cls', code: 'INVALID_REQUEST' }, { status: 400 });
  if (!summary) return jsonErrorResponse({ error: 'Missing summary', code: 'INVALID_REQUEST' }, { status: 400 });
  const scope = readOptionalStringField(body, 'scope');
  const detail = readOptionalStringField(body, 'detail');
  const tags = readStringArrayField(body, 'tags');
  const provenance = readProvenanceField(body);
  const review = readReviewField(body);
  return {
    cls,
    summary,
    ...(scope ? { scope } : {}),
    ...(detail ? { detail } : {}),
    ...(tags ? { tags } : {}),
    ...(provenance ? { provenance } : {}),
    ...(review ? { review } : {}),
  };
}

/** Parse POST /api/memory/records/search — every field optional; unknowns ignored. */
export function parseMemoryRecordSearchBody(
  body: JsonRecord,
): { readonly filter: MemoryRecordSearchFilterInput; readonly recall: boolean } {
  const filter: MemoryRecordSearchFilterInput = {
    ...(readOptionalStringField(body, 'scope') ? { scope: readOptionalStringField(body, 'scope') } : {}),
    ...(readOptionalStringField(body, 'cls') ? { cls: readOptionalStringField(body, 'cls') } : {}),
    ...(readStringArrayField(body, 'tags') ? { tags: readStringArrayField(body, 'tags') } : {}),
    ...(readOptionalStringField(body, 'query') ? { query: readOptionalStringField(body, 'query') } : {}),
    ...(readOptionalBooleanField(body, 'semantic') !== undefined ? { semantic: readOptionalBooleanField(body, 'semantic') } : {}),
    ...(readOptionalNumberField(body, 'since') !== undefined ? { since: readOptionalNumberField(body, 'since') } : {}),
    ...(readStringArrayField(body, 'reviewState') ? { reviewState: readStringArrayField(body, 'reviewState') } : {}),
    ...(readOptionalNumberField(body, 'minConfidence') !== undefined ? { minConfidence: readOptionalNumberField(body, 'minConfidence') } : {}),
    ...(readStringArrayField(body, 'provenanceKinds') ? { provenanceKinds: readStringArrayField(body, 'provenanceKinds') } : {}),
    ...(readOptionalBooleanField(body, 'staleOnly') !== undefined ? { staleOnly: readOptionalBooleanField(body, 'staleOnly') } : {}),
    ...(readOptionalNumberField(body, 'limit') !== undefined ? { limit: readOptionalNumberField(body, 'limit') } : {}),
  };
  return { filter, recall: readOptionalBooleanField(body, 'recall') === true };
}

/** Parse POST /api/memory/records/:id/review — all review fields optional; id comes from the path. */
export function parseMemoryRecordReviewBody(body: JsonRecord): MemoryRecordReviewInput {
  const state = readOptionalStringField(body, 'state');
  const confidence = readOptionalNumberField(body, 'confidence');
  const reviewedBy = readOptionalStringField(body, 'reviewedBy');
  const staleReason = readOptionalStringField(body, 'staleReason');
  return {
    ...(state ? { state } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reviewedBy ? { reviewedBy } : {}),
    ...(staleReason ? { staleReason } : {}),
  };
}
