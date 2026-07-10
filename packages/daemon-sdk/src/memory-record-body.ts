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
  MemoryBundleInput,
  MemoryLinkInput,
  MemoryProvenanceLinkInput,
  MemoryRecordAddInput,
  MemoryRecordReviewInput,
  MemoryRecordSearchFilterInput,
  MemoryRecordUpdateInput,
} from './integration-route-types.js';

function readOptionalNumberField(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalBooleanField(body: JsonRecord, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Read a nullable-number field, preserving the three distinct states the store's
 * temporal window needs: a finite number SETS the bound, an explicit `null`
 * CLEARS it, and any other value (including absent) returns `undefined` so the
 * bound is left UNCHANGED. Used only where null-to-clear is meaningful
 * (validFrom/validUntil).
 */
function readNullableNumberField(body: JsonRecord, key: string): number | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

/** Parse a memory search filter — every field optional; unknowns ignored. Shared by search/list/searchSemantic/export. */
export function parseMemoryRecordFilterBody(body: JsonRecord): MemoryRecordSearchFilterInput {
  return {
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
}

/** Parse POST /api/memory/records/search — every field optional; unknowns ignored. */
export function parseMemoryRecordSearchBody(
  body: JsonRecord,
): { readonly filter: MemoryRecordSearchFilterInput; readonly recall: boolean } {
  return { filter: parseMemoryRecordFilterBody(body), recall: readOptionalBooleanField(body, 'recall') === true };
}

/**
 * Parse POST /api/memory/records/:id/update — editable fields
 * (scope/summary/detail/tags + the temporal validity window). All optional; the
 * store leaves unset fields unchanged. NOT a review update (that is the /review
 * route) — this edits content/scope, e.g. promoting a record project→team.
 *
 * validFrom/validUntil carry the store's three-state window semantics: a number
 * sets the bound, an explicit `null` clears it, and an absent field leaves it
 * unchanged — so a proposal that changes only the window round-trips.
 */
export function parseMemoryRecordUpdateBody(body: JsonRecord): MemoryRecordUpdateInput {
  const scope = readOptionalStringField(body, 'scope');
  const summary = readOptionalStringField(body, 'summary');
  const detail = body.detail === null ? '' : readOptionalStringField(body, 'detail');
  const tags = readStringArrayField(body, 'tags');
  const validFrom = readNullableNumberField(body, 'validFrom');
  const validUntil = readNullableNumberField(body, 'validUntil');
  return {
    ...(scope ? { scope } : {}),
    ...(summary ? { summary } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(tags ? { tags } : {}),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
  };
}

/** Parse POST /api/memory/records/:id/links — toId and relation are required (fromId is the path id). */
export function parseMemoryLinkBody(body: JsonRecord): MemoryLinkInput | Response {
  const toId = readOptionalStringField(body, 'toId');
  const relation = readOptionalStringField(body, 'relation');
  if (!toId) return jsonErrorResponse({ error: 'Missing toId', code: 'INVALID_REQUEST' }, { status: 400 });
  if (!relation) return jsonErrorResponse({ error: 'Missing relation', code: 'INVALID_REQUEST' }, { status: 400 });
  return { toId, relation };
}

/**
 * Parse POST /api/memory/records/import — a { bundle } envelope holding a MemoryBundle.
 * Records/links are passed through loosely; the store re-normalizes scope/reviewState/
 * confidence per record and skips ids it already holds (no-loss id-keyed union).
 */
export function parseMemoryBundleImportBody(body: JsonRecord): MemoryBundleInput | Response {
  const bundle = body.bundle;
  if (!isJsonRecord(bundle)) {
    return jsonErrorResponse({ error: 'Missing bundle', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  if (!Array.isArray(bundle.records)) {
    return jsonErrorResponse({ error: 'bundle.records must be an array', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  if (bundle.links !== undefined && !Array.isArray(bundle.links)) {
    return jsonErrorResponse({ error: 'bundle.links must be an array', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  return { bundle: bundle as unknown as MemoryBundleInput['bundle'] };
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
