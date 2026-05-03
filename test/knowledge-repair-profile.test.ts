import { describe, expect, test } from 'bun:test';
import { deriveRepairProfileFacts } from '../packages/sdk/src/platform/knowledge/semantic/repair-profile.js';
import type { KnowledgeSourceRecord } from '../packages/sdk/src/platform/knowledge/types.js';

const source: KnowledgeSourceRecord = {
  id: 'source-lg',
  connectorId: 'semantic-gap-repair',
  sourceType: 'url',
  title: 'LG 86NANO90UNA specifications',
  sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una',
  canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una',
  tags: [],
  status: 'indexed',
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
};

describe('repair profile facts', () => {
  test('derives typed profile facts from concrete feature evidence', () => {
    const facts = deriveRepairProfileFacts({
      query: 'What refresh rate, ports, audio, gaming, and smart TV features does the LG 86NANO90UNA have?',
      source,
      text: [
        'LG 86NANO90UNA is an 86 inch 4K UHD NanoCell TV with 3840 x 2160 resolution.',
        'It supports HDR10, Dolby Vision, HLG, TruMotion 240, and 120 Hz refresh rate.',
        'Inputs include HDMI, HDMI eARC, USB, Ethernet RJ45, optical audio, RF antenna, and RS-232C.',
        'Audio includes 2 x 10 W speakers and Dolby Atmos. Smart features include webOS, AirPlay 2, HomeKit, and voice assistant support.',
        'Gaming features include FreeSync VRR, ALLM, Game Optimizer, and HDMI 2.1 support.',
      ].join(' '),
    });

    expect(facts.map((fact) => fact.title)).toContain('Display and picture specifications');
    expect(facts.map((fact) => fact.title)).toContain('Input and output ports');
    expect(facts.map((fact) => fact.title)).toContain('Audio capabilities');
    expect(facts.map((fact) => fact.title)).toContain('Gaming and HDMI features');
    expect(facts.every((fact) => fact.kind === 'feature' || fact.kind === 'capability' || fact.kind === 'specification')).toBe(true);
  });

  test('does not promote URL or table debris as profile facts', () => {
    const facts = deriveRepairProfileFacts({
      query: 'complete features specifications LG 86NANO90UNA',
      source,
      text: 'series_url https://example.com/lg/86nano90una current page loading 18 m (86") table row current page',
    });

    expect(facts).toEqual([]);
  });
});
