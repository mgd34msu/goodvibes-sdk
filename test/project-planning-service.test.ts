import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ProjectPlanningService,
  projectKnowledgeSpaceId,
} from '../packages/sdk/src/_internal/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project planning service', () => {
  test('stores planning artifacts in isolated project knowledge spaces', async () => {
    const service = createService();
    await service.upsertState({
      projectId: 'alpha',
      state: {
        goal: 'Add conversational planning support',
        scope: 'SDK contracts only',
        tasks: [{
          id: 'contracts',
          title: 'Add passive planning contracts',
          verification: ['bun test test/project-planning-service.test.ts'],
        }],
        verificationGates: [{
          id: 'unit-tests',
          description: 'Project planning tests pass',
          required: true,
        }],
        executionApproved: true,
      },
    });
    await service.recordDecision({
      projectId: 'alpha',
      decision: {
        title: 'Planning loop remains TUI-owned',
        decision: 'The daemon stores/evaluates planning artifacts but never drives the interview.',
        reasoning: 'Programmatic surfaces should not enter conversational planning loops.',
      },
    });
    await service.upsertLanguage({
      projectId: 'alpha',
      language: {
        terms: [{
          term: 'Surface',
          definition: 'A user-facing channel where GoodVibes receives or sends interaction.',
          avoid: ['client'],
        }],
        ambiguities: [{
          phrase: 'agent channel',
          resolution: 'Split into chat and background agent routes.',
        }],
      },
    });

    const alpha = await service.getState({ projectId: 'alpha' });
    const beta = await service.getState({ projectId: 'beta' });
    const status = await service.status({ projectId: 'alpha' });
    const decisions = await service.listDecisions({ projectId: 'alpha' });
    const language = await service.getLanguage({ projectId: 'alpha' });

    expect(alpha.knowledgeSpaceId).toBe(projectKnowledgeSpaceId('alpha'));
    expect(alpha.state?.readiness).toBe('executable');
    expect(beta.state).toBeNull();
    expect(status.counts).toEqual({ states: 1, decisions: 1, languageArtifacts: 1 });
    expect(status.passiveOnly).toBe(true);
    expect(decisions.decisions[0]?.title).toBe('Planning loop remains TUI-owned');
    expect(language.language?.terms[0]?.term).toBe('Surface');
  });

  test('evaluates gaps and next questions without mutating stored state', async () => {
    const service = createService();
    const evaluation = await service.evaluate({
      projectId: 'alpha',
      state: {
        goal: 'Improve setup',
      },
    });
    const status = await service.status({ projectId: 'alpha' });

    expect(evaluation.readiness).toBe('needs-user-input');
    expect(evaluation.gaps.map((gap) => gap.kind)).toContain('missing-scope');
    expect(evaluation.gaps.map((gap) => gap.kind)).toContain('ambiguous-language');
    expect(evaluation.nextQuestion?.prompt).toContain('scope');
    expect(status.counts.states).toBe(0);
  });
});

function createService(): ProjectPlanningService {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  return new ProjectPlanningService(store, { defaultProjectId: 'default-project' });
}

