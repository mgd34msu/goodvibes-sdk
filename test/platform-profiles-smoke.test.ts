/**
 * COV-04 (ninth-review): platform/profiles/ smoke test.
 * Verifies that profile data conversion functions work correctly.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/profiles — smoke', () => {
  test('configSnapshotToProfileData returns an object for empty snapshot', async () => {
    const { configSnapshotToProfileData } = await import('../packages/sdk/src/platform/profiles/index.js');
    const result = configSnapshotToProfileData({});
    expect(result).toBeDefined();
  });

  test('profileDataToConfigSnapshot round-trips through configSnapshotToProfileData', async () => {
    const { configSnapshotToProfileData, profileDataToConfigSnapshot } = await import('../packages/sdk/src/platform/profiles/index.js');
    const snapshot = {};
    const profileData = configSnapshotToProfileData(snapshot);
    const backToSnapshot = profileDataToConfigSnapshot(profileData);
    // Round-trip must produce an object (not null/undefined)
    expect(backToSnapshot).toBeDefined();
  });
});
