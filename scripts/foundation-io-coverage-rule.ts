// foundation-io-coverage-rule.ts
//
// Pure logic for the typed-IO coverage ratchet enforced by
// check-foundation-io-coverage.ts. Kept separate from the file-reading driver
// (mirrors line-cap-rule.ts vs check-line-cap.ts) so the counting and
// ratchet-comparison rules can be unit-tested without touching disk.
//
// "Typed IO" for an operator method means the method id appears as a key in
// BOTH OperatorMethodInputMap AND OperatorMethodOutputMap in
// packages/contracts/src/generated/foundation-client-types.ts. A method absent
// from either map resolves to the broad fallback (`{ readonly [key: string]:
// unknown }` for input, `unknown` for output) via OperatorMethodInput/Output.
// Those are the "untyped" methods this ratchet counts and freezes.

/** Extract the quoted keys of one `export interface <MapName> { ... }` block. */
export function parseMapKeys(fileText: string, mapName: string): Set<string> {
  const start = fileText.indexOf(`export interface ${mapName} {`);
  if (start === -1) return new Set();
  const end = fileText.indexOf('\n}', start);
  const body = fileText.slice(start, end === -1 ? undefined : end);
  const keys = new Set<string>();
  for (const match of body.matchAll(/^ {2}"([^"]+)":/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

/** Extract the dotted ids from the generated operator-method-ids.ts source. */
export function parseMethodIds(idsFileText: string): string[] {
  return [...idsFileText.matchAll(/^ {2}"([^"]+)",/gm)].map((m) => m[1]);
}

/**
 * The sorted list of operator method ids that lack full typed IO — i.e. are not
 * present as a key in both the input and output maps.
 */
export function untypedMethodIds(
  methodIds: readonly string[],
  inputKeys: ReadonlySet<string>,
  outputKeys: ReadonlySet<string>,
): string[] {
  return methodIds.filter((id) => !inputKeys.has(id) || !outputKeys.has(id)).sort();
}

export type RatchetDirection = 'ok' | 'increased' | 'decreased';

export interface RatchetResult {
  readonly direction: RatchetDirection;
  readonly current: number;
  readonly baseline: number;
  /** True only when the current count is at or below (equal to) the baseline in a way that requires no action. */
  readonly ok: boolean;
}

/**
 * Compare the current untyped count to the frozen baseline:
 *   - increased  -> FAIL: new untyped methods landed; add their typed IO entries.
 *   - decreased  -> FAIL: coverage improved; lower the checked-in baseline to lock it in
 *                   (a ratchet must never outlive the count it recorded — mirrors the
 *                   line-cap stale-entry rule).
 *   - ok (equal) -> pass.
 */
export function evaluateRatchet(current: number, baseline: number): RatchetResult {
  if (current > baseline) return { direction: 'increased', current, baseline, ok: false };
  if (current < baseline) return { direction: 'decreased', current, baseline, ok: false };
  return { direction: 'ok', current, baseline, ok: true };
}
