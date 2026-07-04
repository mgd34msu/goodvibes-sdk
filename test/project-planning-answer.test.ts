/**
 * project-planning-answer.test.ts
 *
 * ProjectPlanningService.answerQuestion() — the real answer path behind
 * /plan answer (DEBT-3).
 *
 * Under test:
 *   - Answer by questionId → moves open → answered, records text/answeredAt.
 *   - Answer by zero-based questionIndex → same.
 *   - Recorded answer is CONSUMED: the open-question readiness gap clears on the
 *     next evaluation.
 *   - Honest failures (no state / empty answer / missing selector / unknown
 *     question) return answered: false with a reason and no mutation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ProjectPlanningService } from '../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createService(): ProjectPlanningService {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-planning-answer-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  return new ProjectPlanningService(store, { defaultProjectId: 'default-project' });
}

async function seedWithOpenQuestion(service: ProjectPlanningService): Promise<void> {
  await service.upsertState({
    projectId: 'alpha',
    state: {
      goal: 'Ship the answer path end-to-end',
      scope: 'SDK service only',
      tasks: [{
        id: 't1', title: 'Implement answerQuestion',
        verification: ['bun test test/project-planning-answer.test.ts'],
      }],
      verificationGates: [{ id: 'g1', description: 'answer tests pass', required: true }],
      openQuestions: [
        { id: 'q-scope', prompt: 'What is the first-pass scope?', status: 'open' },
        { id: 'q-owner', prompt: 'Who owns rollout?', status: 'open' },
      ],
      executionApproved: true,
    },
  });
}

describe('ProjectPlanningService.answerQuestion', () => {
  test('answers by questionId — moves open → answered and records the text', async () => {
    const service = createService();
    await seedWithOpenQuestion(service);

    const result = await service.answerQuestion({
      projectId: 'alpha',
      questionId: 'q-scope',
      answer: 'A focused first-pass scope covering the SDK service only.',
    });

    expect(result.answered).toBe(true);
    expect(result.question?.id).toBe('q-scope');
    expect(result.question?.status).toBe('answered');
    expect(result.question?.answer).toBe('A focused first-pass scope covering the SDK service only.');
    expect(typeof result.question?.answeredAt).toBe('number');

    // Open questions no longer include the answered one; the other remains.
    expect(result.openQuestions.map((q) => q.id)).toEqual(['q-owner']);

    // Persisted: a fresh read reflects the move.
    const reread = await service.getState({ projectId: 'alpha' });
    expect(reread.state?.openQuestions.map((q) => q.id)).toEqual(['q-owner']);
    expect(reread.state?.answeredQuestions.map((q) => q.id)).toContain('q-scope');
  });

  test('answers by zero-based questionIndex', async () => {
    const service = createService();
    await seedWithOpenQuestion(service);

    const result = await service.answerQuestion({
      projectId: 'alpha',
      questionIndex: 1,
      answer: 'The platform team owns rollout.',
    });

    expect(result.answered).toBe(true);
    expect(result.question?.id).toBe('q-owner');
    expect(result.openQuestions.map((q) => q.id)).toEqual(['q-scope']);
  });

  test('recorded answer is consumed — its open-question gap clears', async () => {
    const service = createService();
    await seedWithOpenQuestion(service);

    const before = await service.evaluate({ projectId: 'alpha' });
    const scopeGapBefore = before.gaps.some((g) => g.id === 'open-question:q-scope');
    expect(scopeGapBefore).toBe(true);

    const result = await service.answerQuestion({
      projectId: 'alpha', questionId: 'q-scope', answer: 'Focused first pass.',
    });
    const scopeGapAfter = result.evaluation.gaps.some((g) => g.id === 'open-question:q-scope');
    expect(scopeGapAfter).toBe(false);
    // The other open question still gates.
    expect(result.evaluation.gaps.some((g) => g.id === 'open-question:q-owner')).toBe(true);
  });

  test('honest failure: unknown question id → answered:false, no mutation', async () => {
    const service = createService();
    await seedWithOpenQuestion(service);

    const result = await service.answerQuestion({
      projectId: 'alpha', questionId: 'q-does-not-exist', answer: 'anything',
    });
    expect(result.answered).toBe(false);
    expect(result.reason).toBe('question-not-found');
    expect(result.openQuestions.map((q) => q.id)).toEqual(['q-scope', 'q-owner']);
  });

  test('honest failure: empty answer → answered:false, no mutation', async () => {
    const service = createService();
    await seedWithOpenQuestion(service);
    const result = await service.answerQuestion({ projectId: 'alpha', questionId: 'q-scope', answer: '   ' });
    expect(result.answered).toBe(false);
    expect(result.reason).toBe('empty-answer');
  });

  test('honest failure: no selector → answered:false', async () => {
    const service = createService();
    await seedWithOpenQuestion(service);
    const result = await service.answerQuestion({ projectId: 'alpha', answer: 'text' });
    expect(result.answered).toBe(false);
    expect(result.reason).toBe('missing-selector');
  });

  test('honest failure: no state at all → answered:false with reason no-state', async () => {
    const service = createService();
    const result = await service.answerQuestion({ projectId: 'empty', questionId: 'x', answer: 'text' });
    expect(result.answered).toBe(false);
    expect(result.reason).toBe('no-state');
    expect(result.state).toBeNull();
  });
});
