/**
 * merchant-judge-model.ts — the judgement, made by a model.
 *
 * ══ The last link in "determine if it is reputable" ═══════════════════════
 *
 * `merchant-recourse.ts` owns the criterion, the policy and the composition
 * rules; it does not make the call. This is the call, and it is deliberately
 * the smallest module in the capability: build a prompt from a constant and one
 * domain, read back a verdict, fail safe.
 *
 * ══ One field goes in, and that is the whole safety argument ══════════════
 *
 * The prompt is assembled from exactly two things: `MERCHANT_RECOURSE_CRITERION`,
 * which ships in this repository, and `input.registrableDomain`, which we
 * computed from a URL that already passed `validateLinkTarget`.
 *
 * Nothing else. No page title, no seller name, no review count, no product
 * description, no "as seen in" strip, no trust badge, no anything the merchant
 * controls. Every one of those is free text written by the party whose
 * trustworthiness is the question, and a judgement made over them is a
 * judgement the attacker writes. A fake storefront's entire investment is in
 * looking legitimate, and that investment lands precisely on the material this
 * module refuses to read.
 *
 * There is a test asserting the port is called with the key set
 * `['registrableDomain']` and nothing more, so widening the input breaks a
 * test rather than quietly widening the attack surface.
 *
 * ══ Every failure is not-major ════════════════════════════════════════════
 *
 * Helper disabled, no route configured, a timeout, a malformed answer, prose
 * where JSON was asked for, a verdict word we do not recognise — all resolve to
 * `qualifies: false, confident: false`, which `classifyMerchant` turns into an
 * approval window where silence denies.
 *
 * That direction is not arbitrary. Being unable to judge a legitimate small
 * retailer costs him one question he answers in a second; treating an
 * unjudgeable domain as established costs him a silent purchase from a
 * storefront nobody vouched for. A model outage must never be able to make
 * spending MORE automatic.
 */
import { MERCHANT_RECOURSE_CRITERION } from './merchant-recourse.js';
import type { MerchantJudgeInput, MerchantJudgePort, MerchantJudgement } from './merchant-recourse.js';

/** The slice of the helper model this needs. Injectable so tests need no provider. */
export interface MerchantJudgeModel {
  chat(
    task: 'intent_classify',
    prompt: string,
    options: { readonly maxTokens?: number; readonly systemPrompt?: string },
  ): Promise<string | null>;
}

/**
 * The answer shape the model is asked for.
 *
 * Small and closed on purpose. A free-text answer would have to be interpreted,
 * and interpreting prose about whether to spend money is exactly the step where
 * a confident-sounding sentence becomes a purchase.
 */
const RESPONSE_INSTRUCTIONS = [
  'Answer with a single JSON object and nothing else:',
  '{"qualifies": true|false, "confident": true|false, "recourse": "<short phrase>", "marketplace": "<optional>"}',
  '',
  '"qualifies" is your verdict against the criterion above.',
  '"confident" is false when you do not recognise the domain well enough to be sure —',
  'say so rather than guessing, because an unsure answer is treated the same as no.',
  '"recourse" is a short phrase naming what protection you believe exists, in plain words,',
  'for a human to read on their phone — for example "established electronics retailer with a returns process"',
  'or "marketplace with buyer protection". Do not restate the domain.',
].join('\n');

/** How long an answer may be. A verdict does not need an essay. */
const MAX_TOKENS = 200;

function unknownVerdict(recourse: string): MerchantJudgement {
  return { qualifies: false, confident: false, recourse };
}

/**
 * Read the model's answer, or refuse to.
 *
 * Tolerates the answer being wrapped in a code fence, which models do
 * routinely, and nothing else. Anything that does not parse into the expected
 * shape is an unknown verdict rather than a salvage attempt.
 */
function parseVerdict(raw: string): MerchantJudgement | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  // `qualifies` must be a real boolean. A string "true", a 1, or a missing
  // field is not a verdict — it is a model that did not follow the format, and
  // coercing it would be inventing an answer.
  if (typeof record['qualifies'] !== 'boolean') return null;

  const recourse = typeof record['recourse'] === 'string' && record['recourse'].trim().length > 0
    ? record['recourse'].trim().slice(0, 200)
    : 'no recourse stated';

  const marketplace = typeof record['marketplace'] === 'string' && record['marketplace'].trim().length > 0
    ? record['marketplace'].trim().slice(0, 40)
    : undefined;

  return {
    qualifies: record['qualifies'],
    // Absent confidence is treated as NOT confident. The safe reading of "the
    // model did not say" is that it was not sure.
    confident: record['confident'] === true,
    recourse,
    ...(marketplace === undefined ? {} : { marketplace: marketplace as MerchantJudgement['marketplace'] }),
  };
}

/**
 * A judge backed by the helper model.
 *
 * `intent_classify` is the routing task: this IS a classification — one short
 * input, one closed verdict — and it inherits that route's model and limits
 * rather than introducing a payment-specific route the owner would have to
 * configure separately before he could buy anything.
 */
export function createModelMerchantJudge(model: MerchantJudgeModel): MerchantJudgePort {
  return {
    async judge(input: MerchantJudgeInput): Promise<MerchantJudgement> {
      const domain = input.registrableDomain.trim().toLowerCase();
      if (domain.length === 0) {
        return unknownVerdict('I could not establish which domain this checkout is on');
      }

      let answer: string | null;
      try {
        answer = await model.chat(
          'intent_classify',
          // The ONLY variable content in this prompt. Everything else is a
          // constant shipped in this repository.
          `Domain: ${domain}`,
          {
            maxTokens: MAX_TOKENS,
            systemPrompt: `${MERCHANT_RECOURSE_CRITERION}\n\n${RESPONSE_INSTRUCTIONS}`,
          },
        );
      } catch {
        // Helper disabled, no route, provider error, timeout. The error is not
        // surfaced: what matters downstream is that no judgement was available.
        return unknownVerdict('I could not reach a model to judge this merchant, so I am asking first');
      }

      if (answer === null || answer.trim().length === 0) {
        return unknownVerdict('No judgement was available for this merchant, so I am asking first');
      }

      const verdict = parseVerdict(answer);
      if (verdict === null) {
        return unknownVerdict('I could not read a clear judgement about this merchant, so I am asking first');
      }
      return verdict;
    },
  };
}
