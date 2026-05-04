import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'bun:test';
import { ArtifactStore } from '../../packages/sdk/src/platform/artifacts/index.js';
import type { KnowledgeSemanticLlm } from '../../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../../packages/sdk/src/platform/knowledge/store.js';
import { waitFor as _canonicalWaitFor } from './test-timeout.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

export class FakeKnowledgeLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string; readonly signal?: AbortSignal }): Promise<unknown | null> {
    if (input.signal?.aborted) return null;
    if (input.purpose === 'knowledge-semantic-enrichment') {
      return {
        summary: 'Manual describing display and input features.',
        entities: [{ title: 'Device', kind: 'device', aliases: ['TV'], summary: 'The described device.', confidence: 80 }],
        facts: [
          {
            kind: 'feature',
            title: 'Dolby Vision support',
            summary: 'The device supports Dolby Vision.',
            evidence: 'supports Dolby Vision',
            confidence: 92,
            labels: ['display'],
            targetHints: ['Device'],
          },
          {
            kind: 'specification',
            title: 'HDMI inputs',
            value: 'four HDMI ports',
            summary: 'The device includes four HDMI ports.',
            evidence: 'includes four HDMI ports',
            confidence: 94,
            labels: ['hdmi'],
            targetHints: ['Device'],
          },
        ],
        relations: [],
        gaps: [],
        wikiPage: {
          title: 'Device knowledge page',
          markdown: '# Device\n\n## Features\n\n- Supports Dolby Vision.\n- Includes four HDMI ports.\n',
        },
      };
    }
    return {
      answer: 'The device supports Dolby Vision and has four HDMI ports.',
      confidence: 91,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

export class GapRepairAnswerLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string; readonly signal?: AbortSignal }): Promise<unknown | null> {
    if (input.signal?.aborted) return null;
    if (input.purpose !== 'knowledge-answer-synthesis') return null;
    return {
      answer: 'The manual only confirms Magic Remote Bluetooth compatibility.',
      confidence: 45,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [{
        question: 'What are the complete display, smart platform, audio, and port specifications?',
        reason: 'The manual is not a complete product specification sheet.',
        severity: 'info',
      }],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

export class WeakFeatureAnswerLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string; readonly signal?: AbortSignal }): Promise<unknown | null> {
    if (input.signal?.aborted) return null;
    if (input.purpose !== 'knowledge-answer-synthesis') return null;
    return {
      answer: 'The supplied evidence identifies the TV as having an LCD screen.',
      confidence: 10,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

export class ForegroundRepairLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string; readonly prompt?: string }): Promise<unknown | null> {
    if (input.purpose === 'knowledge-semantic-enrichment') {
      return {
        summary: 'LG 86NANO90UNA product specifications.',
        entities: [],
        facts: [{
          kind: 'feature',
          title: 'NanoCell 4K feature set',
          summary: 'The TV supports NanoCell 4K, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer.',
          evidence: 'NanoCell 4K display, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer',
          confidence: 92,
        }],
        relations: [],
        gaps: [],
      };
    }
    if (input.purpose === 'knowledge-answer-synthesis') {
      const prompt = input.prompt ?? '';
      if (prompt.includes('NanoCell 4K')) {
        return {
          answer: 'The LG 86NANO90UNA feature set includes NanoCell 4K display, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer.',
          confidence: 90,
          usedSourceIds: [],
          usedNodeIds: [],
          gaps: [],
        };
      }
      return {
        answer: 'The evidence only identifies the device as an LG webOS Smart TV.',
        confidence: 0,
        usedSourceIds: [],
        usedNodeIds: [],
        gaps: [{
          question: 'What are the complete features and specifications for LG 86NANO90UNA?',
          reason: 'The current evidence lacks product feature/specification details.',
          severity: 'info',
        }],
      };
    }
    return null;
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

/**
 * Delegates to the canonical waitFor from test/_helpers/test-timeout.ts.
 * The canonical version uses timer.unref() to avoid hanging the process.
 */
export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return _canonicalWaitFor(predicate, { timeoutMs, intervalMs: 5 });
}

export class OrderedHomeGraphAskLlm implements KnowledgeSemanticLlm {
  readonly calls: string[] = [];

  async completeJson(input: { readonly purpose: string; readonly signal?: AbortSignal }): Promise<unknown | null> {
    if (input.signal?.aborted) return null;
    this.calls.push(input.purpose);
    if (input.purpose === 'knowledge-answer-synthesis') {
      return {
        answer: 'The TV supports Dolby Vision and includes four HDMI ports. The available evidence does not include the full feature specification list.',
        confidence: 82,
        usedSourceIds: [],
        usedNodeIds: [],
        gaps: [{
          question: 'What are the complete TV feature specifications?',
          reason: 'The linked manual excerpt does not provide every display, audio, network, and app feature.',
          severity: 'info',
        }],
      };
    }
    return {
      summary: 'Manual describing display and input features.',
      entities: [],
      facts: [{
        kind: 'feature',
        title: 'Dolby Vision support',
        summary: 'The TV supports Dolby Vision.',
        evidence: 'supports Dolby Vision',
        confidence: 90,
      }],
      relations: [],
      gaps: [],
      wikiPage: {
        title: 'Living Room TV knowledge page',
        markdown: '# Living Room TV\n\n- Supports Dolby Vision.\n',
      },
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

export class BoilerplateAnswerLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string; readonly signal?: AbortSignal }): Promise<unknown | null> {
    if (input.signal?.aborted) return null;
    if (input.purpose !== 'knowledge-answer-synthesis') return null;
    return {
      answer: [
        '- The TV supports HDMI Ultra HD Deep Color, including 4K at 100/120 Hz on ports 3 and 4.',
        '- It supports True HD, Dolby Digital, Dolby Digital Plus, and PCM HDMI audio formats.',
        '- It includes IEEE 802.11a/b/g/n/ac wireless LAN and Bluetooth support.',
        '- Use an extension cable if the USB flash drive does not fit into your TV USB port.',
        '- New features may be added to this TV in the future.',
        '- Use a platform or cabinet that is strong and large enough to support the TV securely.',
      ].join('\n'),
      confidence: 84,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [{
        question: 'What are the full display, smart platform, audio, and port specifications for this TV?',
        reason: 'The manual is a safety/reference manual and does not include a complete product feature sheet.',
        severity: 'info',
      }],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

export class SlowKnowledgeLlm implements KnowledgeSemanticLlm {
  constructor(private readonly delayMs: number) {}

  async completeJson(input: { readonly purpose: string; readonly signal?: AbortSignal }): Promise<unknown | null> {
    if (input.signal?.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (input.purpose !== 'knowledge-semantic-enrichment') return null;
    return {
      summary: 'Slow semantic extraction.',
      entities: [],
      facts: [{
        kind: 'feature',
        title: 'HDMI support',
        summary: 'The device supports HDMI.',
        evidence: 'supports HDMI',
        confidence: 80,
      }],
      relations: [],
      gaps: [],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

export function createStores(): { readonly store: KnowledgeStore; readonly artifactStore: ArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-semantic-'));
  tmpRoots.push(root);
  return {
    store: new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
  };
}

