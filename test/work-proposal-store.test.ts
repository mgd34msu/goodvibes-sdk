/**
 * Pending work proposals — the housekeeping contract.
 *
 * A proposal outlives the turn that created it, so it has to be bounded,
 * expiring, content-validated, reaped on recovery, and disclosed. The
 * load-bearing property is that a stale proposal must NOT be answerable days
 * later: an expired record is gone, and resolving it fails rather than
 * starting work the owner asked for and forgot about.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORK_PROPOSAL_SCHEMA_VERSION,
  WorkProposalStore,
  validateWorkProposal,
} from '../packages/sdk/src/platform/agents/work-proposal-store.ts';

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    surfaceKind: 'ntfy',
    task: 'fix the login bug',
    summary: 'fix the login bug',
    ttlMs: 30 * 60_000,
    ...overrides,
  } as Parameters<WorkProposalStore['create']>[0];
}

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gv-work-proposals-'));
  return join(dir, 'work-proposals.json');
}

describe('WorkProposalStore lifecycle', () => {
  test('a created proposal is pending and answerable', () => {
    const store = new WorkProposalStore();
    const proposal = store.create(makeInput());
    expect(proposal.status).toBe('pending');
    expect(store.listPending({ surfaceKind: 'ntfy' })).toHaveLength(1);
    expect(store.resolve(proposal.id, 'accepted')?.status).toBe('accepted');
    store.dispose();
  });

  test('a proposal can only be answered once', () => {
    const store = new WorkProposalStore();
    const proposal = store.create(makeInput());
    expect(store.resolve(proposal.id, 'accepted')).not.toBeNull();
    expect(store.resolve(proposal.id, 'accepted')).toBeNull();
    expect(store.resolve(proposal.id, 'declined')).toBeNull();
    store.dispose();
  });

  test('an unknown id resolves to null', () => {
    const store = new WorkProposalStore();
    expect(store.resolve('wp_nope', 'accepted')).toBeNull();
    store.dispose();
  });
});

describe('WorkProposalStore expiry', () => {
  test('an expired proposal is unanswerable and no longer listed', () => {
    let now = 1_000_000;
    const store = new WorkProposalStore({ now: () => now });
    const proposal = store.create(makeInput({ ttlMs: 60_000 }));
    expect(store.listPending()).toHaveLength(1);

    now += 60_001;
    expect(store.listPending()).toHaveLength(0);
    expect(store.get(proposal.id)).toBeNull();
    // The load-bearing assertion: saying "yes" days later starts nothing.
    expect(store.resolve(proposal.id, 'accepted')).toBeNull();
    store.dispose();
  });

  test('expiry is disclosed, not silent', () => {
    let now = 1_000_000;
    const store = new WorkProposalStore({ now: () => now });
    store.create(makeInput({ ttlMs: 60_000 }));
    now += 60_001;
    store.reap();
    expect(store.disclose().reaped.expired).toBe(1);
    expect(store.disclose().pending).toBe(0);
    store.dispose();
  });
});

describe('WorkProposalStore bounds', () => {
  test('the pending cap drops the oldest, never grows without limit', () => {
    let now = 1_000_000;
    const store = new WorkProposalStore({ maxPending: 3, now: () => now });
    const created = [];
    for (let index = 0; index < 6; index += 1) {
      now += 1_000;
      created.push(store.create(makeInput({ summary: `job ${index}` })));
    }
    const pending = store.listPending();
    expect(pending).toHaveLength(3);
    expect(pending.map((record) => record.summary)).toEqual(['job 5', 'job 4', 'job 3']);
    // The evicted ones are genuinely gone, not merely hidden.
    expect(store.resolve(created[0]!.id, 'accepted')).toBeNull();
    expect(store.disclose().reaped.overCap).toBeGreaterThan(0);
    store.dispose();
  });

  test('oversized task and summary text is truncated on the way in', () => {
    const store = new WorkProposalStore();
    const proposal = store.create(makeInput({ task: 'x'.repeat(50_000), summary: 'y'.repeat(5_000) }));
    expect(proposal.task.length).toBeLessThanOrEqual(8_000);
    expect(proposal.summary.length).toBeLessThanOrEqual(200);
    store.dispose();
  });
});

describe('validateWorkProposal', () => {
  test.each([
    ['not an object', 'nope'],
    ['null', null],
    ['array', []],
    ['missing id', { task: 't', surfaceKind: 'ntfy', createdAt: 1, expiresAt: 2 }],
    ['missing task', { id: 'a', surfaceKind: 'ntfy', createdAt: 1, expiresAt: 2 }],
    ['missing surfaceKind', { id: 'a', task: 't', createdAt: 1, expiresAt: 2 }],
    ['non-finite timestamps', { id: 'a', task: 't', surfaceKind: 'ntfy', createdAt: Number.NaN, expiresAt: 2 }],
    ['expiry before creation', { id: 'a', task: 't', surfaceKind: 'ntfy', createdAt: 5, expiresAt: 4 }],
    ['oversized task', { id: 'a', task: 'x'.repeat(20_000), surfaceKind: 'ntfy', createdAt: 1, expiresAt: 2 }],
  ])('rejects %s without throwing', (_label, value) => {
    expect(validateWorkProposal(value)).toBeNull();
  });

  test('accepts a well-formed record and normalizes an unknown status to pending', () => {
    const record = validateWorkProposal({
      id: 'wp_1', task: 't', surfaceKind: 'ntfy', createdAt: 1, expiresAt: 2, status: 'bogus',
    });
    expect(record?.status).toBe('pending');
  });
});

describe('WorkProposalStore persistence and recovery', () => {
  test('a proposal survives a restart and is still answerable', async () => {
    const path = await tempStorePath();
    const first = new WorkProposalStore({ storePath: path });
    await first.init();
    const proposal = first.create(makeInput());
    await first.flush();
    first.dispose();

    const second = new WorkProposalStore({ storePath: path });
    await second.init();
    expect(second.listPending()).toHaveLength(1);
    expect(second.resolve(proposal.id, 'accepted')?.status).toBe('accepted');
    second.dispose();
  });

  test('proposals that expired while the daemon was down are reaped on load', async () => {
    const path = await tempStorePath();
    await writeFile(path, JSON.stringify({
      version: WORK_PROPOSAL_SCHEMA_VERSION,
      proposals: [{
        id: 'wp_stale',
        createdAt: 1,
        expiresAt: 2,
        status: 'pending',
        surfaceKind: 'ntfy',
        task: 'do the old thing',
        summary: 'do the old thing',
      }],
    }), 'utf-8');

    const store = new WorkProposalStore({ storePath: path });
    const summary = await store.init();
    expect(summary.expired).toBe(1);
    expect(store.listPending()).toHaveLength(0);
    expect(store.resolve('wp_stale', 'accepted')).toBeNull();
    store.dispose();
  });

  test('a malformed record is dropped and counted, the rest of the file survives', async () => {
    const path = await tempStorePath();
    const future = Date.now() + 60 * 60_000;
    await writeFile(path, JSON.stringify({
      version: WORK_PROPOSAL_SCHEMA_VERSION,
      proposals: [
        { id: 'wp_good', createdAt: Date.now(), expiresAt: future, status: 'pending', surfaceKind: 'ntfy', task: 't', summary: 's' },
        { garbage: true },
        'not even an object',
      ],
    }), 'utf-8');

    const store = new WorkProposalStore({ storePath: path });
    const summary = await store.init();
    expect(summary.malformed).toBe(2);
    expect(store.listPending()).toHaveLength(1);
    store.dispose();
  });

  test('an unreadable store starts empty instead of throwing', async () => {
    const path = await tempStorePath();
    await writeFile(path, '{ this is not json', 'utf-8');
    const store = new WorkProposalStore({ storePath: path });
    await expect(store.init()).resolves.toBeDefined();
    expect(store.listPending()).toHaveLength(0);
    store.dispose();
  });

  test('a file from a different schema version is not trusted', async () => {
    const path = await tempStorePath();
    await writeFile(path, JSON.stringify({
      version: WORK_PROPOSAL_SCHEMA_VERSION + 99,
      proposals: [{ id: 'wp_x', createdAt: 1, expiresAt: Date.now() + 60_000, status: 'pending', surfaceKind: 'ntfy', task: 't', summary: 's' }],
    }), 'utf-8');
    const store = new WorkProposalStore({ storePath: path });
    await store.init();
    expect(store.listPending()).toHaveLength(0);
    store.dispose();
  });

  test('a missing store file is not an error', async () => {
    const path = await tempStorePath();
    const store = new WorkProposalStore({ storePath: path });
    await expect(store.init()).resolves.toBeDefined();
    store.dispose();
  });

  test('the persisted file carries its schema version', async () => {
    const path = await tempStorePath();
    const store = new WorkProposalStore({ storePath: path });
    await store.init();
    store.create(makeInput());
    await store.flush();
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as { version: number };
    expect(parsed.version).toBe(WORK_PROPOSAL_SCHEMA_VERSION);
    store.dispose();
  });
});
