import { describe, expect, test } from 'bun:test';
import {
  HOME_STATE_PROVENANCE_CONTRACT,
  buildHomeStateReadResult,
  homeStateProvenance,
  listHomeAssistantTools,
} from '../packages/sdk/src/platform/channels/builtin/homeassistant.js';
import type { HomeAssistantStateRecord } from '../packages/sdk/src/platform/integrations/homeassistant.js';
import { buildHomeAssistantSystemPrompt } from '../packages/sdk/src/platform/daemon/homeassistant-chat.js';

const OBSERVED_AT = '2026-07-09T12:00:00.000Z';

describe('Home Assistant state provenance contract', () => {
  test('a present entity read carries state plus explicit provenance', () => {
    const record: HomeAssistantStateRecord = {
      entity_id: 'cover.garage_door',
      state: 'open',
      last_changed: '2026-07-09T03:15:00.000Z',
      last_updated: '2026-07-09T03:15:00.000Z',
      attributes: { friendly_name: 'Garage Door' },
    };

    const result = buildHomeStateReadResult('cover.garage_door', record, OBSERVED_AT);

    expect(result.ok).toBe(true);
    expect(result.present).toBe(true);
    const provenance = result.provenance as Record<string, unknown>;
    expect(provenance.entity_id).toBe('cover.garage_door');
    expect(provenance.state).toBe('open');
    expect(provenance.last_changed).toBe('2026-07-09T03:15:00.000Z');
    expect(provenance.last_updated).toBe('2026-07-09T03:15:00.000Z');
    expect(provenance.observed_at).toBe(OBSERVED_AT);
    // The contract travels with the data so the model always sees it.
    expect(result.contract).toBe(HOME_STATE_PROVENANCE_CONTRACT);
  });

  test('a present read with no HA timestamps still carries explicit null provenance, never omission', () => {
    const record: HomeAssistantStateRecord = { entity_id: 'sensor.mystery', state: 'unknown' };

    const provenance = homeStateProvenance(record, OBSERVED_AT);

    expect(provenance.entity_id).toBe('sensor.mystery');
    expect(provenance.state).toBe('unknown');
    expect(provenance.last_changed).toBeNull();
    expect(provenance.last_updated).toBeNull();
    expect(provenance.observed_at).toBe(OBSERVED_AT);
  });

  test('an entity absent from the snapshot yields an explicit not-present result, not silence and not a guess', () => {
    const result = buildHomeStateReadResult('light.does_not_exist', null, OBSERVED_AT);

    expect(result.ok).toBe(false);
    expect(result.present).toBe(false);
    expect(result.entityId).toBe('light.does_not_exist');
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(String(result.error)).toContain("don't have state");
    expect(String(result.error)).toContain('light.does_not_exist');
    // No fabricated state or provenance is invented for a missing entity.
    expect(result.state).toBeUndefined();
    expect(result.provenance).toBeUndefined();
    expect(result.contract).toBe(HOME_STATE_PROVENANCE_CONTRACT);
  });
});
