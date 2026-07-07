import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import {
  HomeGraphService,
  KnowledgeSemanticService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { HomeGraphRoutes } from '../packages/sdk/src/platform/daemon/http/home-graph-routes.js';
import type { KnowledgeSemanticLlm } from '../packages/sdk/src/platform/knowledge/semantic/index.js';

interface TriageDecisionScript {
  readonly action: 'reject' | 'review';
  readonly confidence: number;
  readonly reason: string;
  readonly category?: string;
}

/**
 * A fake semantic LLM that reads the triage records out of the prompt and decides
 * per-issue by code. No real model call. Records every completeJson invocation so a
 * test can prove the decision cache prevents re-spend on unchanged issues.
 */
function createFakeTriageLlm(
  decide: (record: { readonly issueId: string; readonly code: string; readonly node?: Record<string, unknown> }) => TriageDecisionScript,
): { readonly llm: KnowledgeSemanticLlm; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const llm: KnowledgeSemanticLlm = {
    completeText: async () => null,
    completeJson: async (input) => {
      calls.push(input);
      const payload = JSON.parse(input.prompt) as { issues: readonly { issueId: string; code: string; node?: Record<string, unknown> }[] };
      return {
        decisions: payload.issues.map((record) => {
          const scripted = decide(record);
          return {
            issueId: record.issueId,
            action: scripted.action,
            category: scripted.category ?? 'not_applicable',
            confidence: scripted.confidence,
            reason: scripted.reason,
          };
        }),
      };
    },
  };
  return { llm, calls };
}

function createTriageService(llm: KnowledgeSemanticLlm | null): {
  readonly root: string;
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-triage-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const semanticService = new KnowledgeSemanticService(store, { llm });
  const service = new HomeGraphService(store, artifactStore, { semanticService });
  return { root, store, artifactStore, service };
}

const TRIAGE_SNAPSHOT = {
  installationId: 'house-1',
  areas: [{ id: 'entry', name: 'Entry' }, { id: 'living-room', name: 'Living Room' }],
  devices: [
    { id: 'front-door-sensor', name: 'Front Door Sensor', areaId: 'entry' },
    { id: 'hallway-motion', name: 'Hallway Motion', areaId: 'entry' },
    { id: 'living-room-tv', name: 'Living Room TV', manufacturer: 'Sony', model: 'Bravia', areaId: 'living-room' },
  ],
  entities: [
    { entity_id: 'binary_sensor.front_door', device_id: 'front-door-sensor', area_id: 'entry', attributes: { friendly_name: 'Front Door', device_class: 'door' } },
    { entity_id: 'binary_sensor.hallway_motion', device_id: 'hallway-motion', area_id: 'entry', attributes: { friendly_name: 'Hallway Motion', device_class: 'motion' } },
    { entity_id: 'media_player.living_room_tv', device_id: 'living-room-tv', area_id: 'living-room', attributes: { friendly_name: 'Living Room TV' } },
  ],
};

describe('Home Graph LLM issue triage', () => {
  test('thresholds decisions, applies rejects with honest provenance, and reviews the rest', async () => {
    const { llm, calls } = createFakeTriageLlm((record) => {
      if (record.code === 'homegraph.device.unknown_battery') {
        return { action: 'reject', confidence: 95, reason: 'Software/mains object; not battery tracked.' };
      }
      // missing_manual: below the 85 threshold on purpose — left for a human.
      return { action: 'review', confidence: 60, reason: 'Needs a human to confirm a manual is required.' };
    });
    const { root, store, service } = createTriageService(llm);
    try {
      await service.syncSnapshot(TRIAGE_SNAPSHOT);
      const before = await service.listIssues({ installationId: 'house-1', status: 'open' });
      const batteryIssues = before.issues.filter((issue) => issue.code === 'homegraph.device.unknown_battery');
      const manualIssues = before.issues.filter((issue) => issue.code === 'homegraph.device.missing_manual');
      expect(batteryIssues.length).toBeGreaterThan(0);
      expect(manualIssues.length).toBeGreaterThan(0);

      const result = await service.runRefinement({ installationId: 'house-1', triage: true, skipGapRefinement: true });
      expect(result.ok).toBe(true);
      const triage = result.triage!;
      expect(triage.configured).toBe(true);
      expect(triage.minConfidence).toBe(85);
      expect(triage.processed).toBe(batteryIssues.length + manualIssues.length);

      // Every decision carries triage provenance.
      expect(triage.decisions.every((decision) => decision.source === 'homegraph-triage')).toBe(true);
      const applied = triage.decisions.filter((decision) => decision.applied);
      expect(applied.length).toBe(batteryIssues.length);
      expect(triage.applied).toBe(batteryIssues.length);
      expect(triage.reviewed).toBe(manualIssues.length);
      // Below-threshold reviews were never auto-applied.
      expect(triage.decisions.filter((decision) => decision.code === 'homegraph.device.missing_manual').every((decision) => !decision.applied)).toBe(true);

      // Applied rejects resolved their issues and derived facts onto the node.
      const openAfter = await service.listIssues({ installationId: 'house-1', status: 'open' });
      for (const battery of batteryIssues) {
        expect(openAfter.issues.some((issue) => issue.id === battery.id)).toBe(false);
        const resolved = store.getIssue(battery.id)!;
        expect(resolved.status).toBe('resolved');
        const reviewValue = (resolved.metadata.review as Record<string, unknown>).value as Record<string, unknown>;
        expect(reviewValue.source).toBe('homegraph-triage');
        expect(reviewValue.confidence).toBe(95);
      }
      const browse = await service.browse({ installationId: 'house-1' });
      const frontDoorNode = browse.nodes.find((node) => node.title === 'Front Door Sensor');
      expect(frontDoorNode?.metadata.batteryPowered).toBe(false);
      expect(frontDoorNode?.metadata.batteryType).toBe('none');

      // Reviewed issues stay open, but now carry a cached triage decision.
      for (const manual of manualIssues) {
        const open = openAfter.issues.find((issue) => issue.id === manual.id)!;
        expect(open.status).toBe('open');
        const cached = open.metadata.triage as Record<string, unknown>;
        expect(cached.action).toBe('review');
        expect(cached.confidence).toBe(60);
        expect(typeof cached.fingerprint).toBe('string');
      }

      const firstRunCalls = calls.length;
      expect(firstRunCalls).toBeGreaterThan(0);

      // Second run: every remaining open triageable issue is cached → no model spend.
      const rerun = await service.runRefinement({ installationId: 'house-1', triage: true, skipGapRefinement: true });
      expect(calls.length).toBe(firstRunCalls);
      expect(rerun.triage!.processed).toBe(0);
      expect(rerun.triage!.skipped).toBe(manualIssues.length);
      expect(rerun.triage!.reason).toBe('no-untriaged-open-issues');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('leaves a separate wiki knowledge space provably untouched (family wall)', async () => {
    const { llm } = createFakeTriageLlm(() => ({ action: 'reject', confidence: 99, reason: 'auto' }));
    const { root, store, service } = createTriageService(llm);
    try {
      // Seed a wiki space that shares the store but is a different knowledge space,
      // carrying an issue with the SAME triageable code the HA loop acts on.
      const wikiSpace = 'wiki:household-notes';
      await store.upsertNode({
        kind: 'topic',
        slug: 'thermostat-notes',
        title: 'Thermostat Notes',
        summary: 'Wiki page about the thermostat.',
        metadata: { knowledgeSpaceId: wikiSpace },
      });
      const wikiNode = store.listNodesInSpace(wikiSpace)[0]!;
      await store.upsertIssue({
        id: 'wiki-issue-1',
        severity: 'warning',
        code: 'homegraph.device.unknown_battery',
        message: 'Wiki page has no known battery type.',
        status: 'open',
        nodeId: wikiNode.id,
        metadata: { knowledgeSpaceId: wikiSpace },
      });
      const wikiNodeBefore = JSON.stringify(store.getNode(wikiNode.id));
      const wikiIssueBefore = JSON.stringify(store.getIssue('wiki-issue-1'));

      await service.syncSnapshot(TRIAGE_SNAPSHOT);
      const result = await service.runRefinement({ installationId: 'house-1', triage: true, skipGapRefinement: true });

      // The wiki records are byte-identical after the HA triage run.
      expect(JSON.stringify(store.getNode(wikiNode.id))).toBe(wikiNodeBefore);
      expect(JSON.stringify(store.getIssue('wiki-issue-1'))).toBe(wikiIssueBefore);
      expect(store.getIssue('wiki-issue-1')!.status).toBe('open');
      // The wiki issue never entered the HA triage decision set.
      expect(result.triage!.decisions.some((decision) => decision.issueId === 'wiki-issue-1')).toBe(false);
      expect(result.spaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is a no-op when no semantic LLM is configured', async () => {
    const { root, service } = createTriageService(null);
    try {
      await service.syncSnapshot(TRIAGE_SNAPSHOT);
      const result = await service.runRefinement({ installationId: 'house-1', triage: true, skipGapRefinement: true });
      expect(result.triage!.configured).toBe(false);
      expect(result.triage!.reason).toBe('triage-llm-not-configured');
      expect(result.triage!.processed).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an added rule extends triage to a new issue code', async () => {
    const { llm, calls } = createFakeTriageLlm(() => ({ action: 'reject', confidence: 90, reason: 'custom-code reject' }));
    const { root, store, service } = createTriageService(llm);
    try {
      await service.syncSnapshot(TRIAGE_SNAPSHOT);
      const spaceId = homeAssistantKnowledgeSpaceId('house-1');
      const haNode = store.listNodesInSpace(spaceId).find((node) => node.title === 'Living Room TV')!;
      await store.upsertIssue({
        id: 'custom-issue-1',
        severity: 'warning',
        code: 'homegraph.device.firmware_unknown',
        message: 'Living Room TV firmware version is unknown.',
        status: 'open',
        nodeId: haNode.id,
        metadata: { knowledgeSpaceId: spaceId },
      });

      // Without a rule the custom code is ignored.
      const ignored = await service.runRefinement({
        installationId: 'house-1',
        triage: { issueCodes: ['homegraph.device.firmware_unknown'] },
        skipGapRefinement: true,
      });
      expect(ignored.triage!.processed).toBe(0);
      expect(calls.length).toBe(0);

      // With an added rule the same code is triaged.
      const triaged = await service.runRefinement({
        installationId: 'house-1',
        triage: {
          issueCodes: ['homegraph.device.firmware_unknown'],
          additionalRules: [{ code: 'homegraph.device.firmware_unknown', defaultCategory: 'not_applicable', promptGuidance: 'Reject firmware-unknown for objects that do not report firmware.' }],
        },
        skipGapRefinement: true,
      });
      expect(calls.length).toBe(1);
      expect(triaged.triage!.processed).toBe(1);
      expect(triaged.triage!.decisions[0]?.code).toBe('homegraph.device.firmware_unknown');
      expect(triaged.triage!.decisions[0]?.applied).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs over the daemon refinement/run route with the triage option', async () => {
    const { llm, calls } = createFakeTriageLlm(() => ({ action: 'review', confidence: 40, reason: 'uncertain' }));
    const { root, artifactStore, service } = createTriageService(llm);
    try {
      await service.syncSnapshot(TRIAGE_SNAPSHOT);

      const routes = new HomeGraphRoutes({
        artifactStore,
        homeGraphService: service,
        parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
        parseOptionalJsonBody: async (req: Request) => {
          const text = await req.text();
          return text ? JSON.parse(text) as Record<string, unknown> : null;
        },
        requireAdmin: () => null,
      });

      const response = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/refinement/run?installationId=house-1', {
        method: 'POST',
        body: JSON.stringify({ triage: true, skipGapRefinement: true }),
      }));
      expect(response!.status).toBe(200);
      const payload = await response!.json() as { ok: boolean; triage?: { configured: boolean; processed: number; decisions: readonly { source: string }[] } };
      expect(payload.ok).toBe(true);
      expect(payload.triage?.configured).toBe(true);
      expect(payload.triage!.processed).toBeGreaterThan(0);
      expect(calls.length).toBeGreaterThan(0);
      expect(payload.triage!.decisions.every((decision) => decision.source === 'homegraph-triage')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
