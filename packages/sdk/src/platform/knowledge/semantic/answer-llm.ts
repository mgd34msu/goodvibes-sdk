import type {
  KnowledgeSemanticGapInput,
  KnowledgeSemanticLlm,
  KnowledgeSemanticLlmAnswer,
} from './types.js';
import type { EvidenceItem } from './answer-common.js';
import {
  MAX_ANSWER_EVIDENCE_CHARS,
  clampText,
  readRecord,
  readString,
  readStringArray,
} from './utils.js';
import { renderFactForPrompt } from './answer-fact-selection.js';
import { uniqueNodes } from './answer-evidence.js';
import { clampTimeoutMs, withTimeoutOrNull } from './timeouts.js';

export async function synthesizeAnswer(
  llm: KnowledgeSemanticLlm | null,
  query: string,
  mode: string,
  evidence: readonly EvidenceItem[],
  requestedTimeoutMs: number | undefined,
): Promise<KnowledgeSemanticLlmAnswer | null> {
  if (!llm) return null;
  const timeoutMs = clampTimeoutMs(requestedTimeoutMs, 15_000, 1_000, 15_000);
  const controller = new AbortController();
  const response = await withTimeoutOrNull(llm.completeJson({
    purpose: 'knowledge-answer-synthesis',
    maxTokens: mode === 'detailed' ? 2200 : mode === 'concise' ? 700 : 1400,
    signal: controller.signal,
    timeoutMs,
    systemPrompt: [
      'You answer questions from a GoodVibes self-improving knowledge wiki.',
      'Use only the supplied evidence. Synthesize the answer for the user intent rather than dumping snippets.',
      'If evidence is insufficient, say what is missing. Prefer concrete features, specs, procedures, and relationships.',
      'For feature or specification questions, ignore manual boilerplate about accessories, cable recommendations, USB/HDMI physical-fit guidance, button maps, remote aiming instructions, batteries, cleaning, servicing, safety, furniture, wall mounting, and future product changes unless the user asks about those topics.',
      'Do not mention future features, specifications changing without notice, cable fit, USB extension cables, remote sensor aiming, service personnel, or child-safety/furniture/platform guidance in a feature/spec answer.',
      'Return only JSON with answer, confidence, usedSourceIds, usedNodeIds, and optional gaps.',
    ].join(' '),
    prompt: JSON.stringify({
      query,
      mode,
      evidence: renderEvidenceForPrompt(evidence),
      outputShape: {
        answer: 'source-backed natural language answer',
        confidence: 0,
        usedSourceIds: ['source ids used'],
        usedNodeIds: ['node ids used'],
        gaps: [{ question: 'unanswered follow-up gap', reason: 'missing evidence', severity: 'info' }],
      },
    }),
  }), timeoutMs);
  controller.abort();
  return normalizeLlmAnswer(response);
}

export function answerConfidence(answer: KnowledgeSemanticLlmAnswer | null, evidence: readonly EvidenceItem[]): number {
  if (typeof answer?.confidence === 'number') return answer.confidence;
  const top = evidence[0]?.score ?? 0;
  const factBoost = Math.min(35, uniqueNodes(evidence.flatMap((item) => item.facts)).length * 4);
  return Math.max(10, Math.min(92, Math.round(top / 5) + factBoost));
}

function renderEvidenceForPrompt(evidence: readonly EvidenceItem[]): readonly Record<string, unknown>[] {
  let budget = MAX_ANSWER_EVIDENCE_CHARS;
  const rendered: Record<string, unknown>[] = [];
  for (const item of evidence.slice(0, 12)) {
    if (budget <= 0) break;
    const factText = item.facts.slice(0, 16).map(renderFactForPrompt).join('\n');
    const excerpt = clampText(item.excerpt, Math.min(1600, budget));
    const record = {
      kind: item.kind,
      id: item.id,
      title: item.title,
      sourceId: item.source?.id,
      nodeId: item.node?.id,
      sourceType: item.source?.sourceType,
      nodeKind: item.node?.kind,
      excerpt,
      facts: factText,
    };
    budget -= JSON.stringify(record).length;
    rendered.push(record);
  }
  return rendered;
}

function normalizeLlmAnswer(value: unknown): KnowledgeSemanticLlmAnswer | null {
  const record = readRecord(value);
  const answer = readString(record.answer);
  if (!answer) return null;
  return {
    answer,
    ...(typeof record.confidence === 'number' ? { confidence: Math.max(0, Math.min(100, Math.round(record.confidence))) } : {}),
    usedSourceIds: readStringArray(record.usedSourceIds),
    usedNodeIds: readStringArray(record.usedNodeIds),
    gaps: readGapArray(record.gaps),
  };
}

function readGapArray(value: unknown): readonly KnowledgeSemanticGapInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const question = readString(record.question);
    if (!question) return [];
    const severity = readString(record.severity);
    return [{
      question,
      ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
      ...(readString(record.subject) ? { subject: readString(record.subject) } : {}),
      severity: severity === 'warning' || severity === 'error' ? severity : 'info',
    }];
  });
}
