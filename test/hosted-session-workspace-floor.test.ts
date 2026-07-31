/**
 * hosted-session-workspace-floor.test.ts
 *
 * The sharing decision, made checkable.
 *
 * The engine composes ONE client floor per workspace and shares it across every
 * hosted session in that workspace, because the floor's cost is a provider
 * discovery pass, config file watchers, a plugin manager and a project index —
 * per-machine or per-workspace truths that duplicate badly. These tests pin the
 * three properties that decision rests on: one construction per workspace, a
 * reference count that releases at zero and not before, and a construction that
 * two simultaneous callers share rather than race.
 */

import { expect, test } from 'bun:test';
import { HostedWorkspaceFloors, type HostedWorkspaceFloor } from '../packages/sdk/src/platform/hosted-sessions/workspace-floor.ts';
import type { ClientRuntimeServices } from '../packages/sdk/src/platform/runtime/client-services.ts';

/** A floor stand-in that records its own construction and disposal. */
function makeFactory() {
  const constructed: string[] = [];
  const disposed: string[] = [];
  let gate: Promise<void> | null = null;
  const factory = async ({ workspaceRoot }: { workspaceRoot: string }): Promise<HostedWorkspaceFloor> => {
    if (gate) await gate;
    constructed.push(workspaceRoot);
    return {
      services: { workingDirectory: workspaceRoot } as unknown as ClientRuntimeServices,
      dispose: (): void => { disposed.push(workspaceRoot); },
    };
  };
  return {
    factory,
    constructed,
    disposed,
    hold(): () => void {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => { release = (): void => { gate = null; resolve(); }; });
      return release;
    },
  };
}

/** Let queued microtasks (the deferred disposal) run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('two sessions in one workspace share one floor', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  const first = await floors.acquire('/w/one');
  const second = await floors.acquire('/w/one');

  expect(spy.constructed).toEqual(['/w/one']);
  expect(second.floor).toBe(first.floor);
  expect(floors.size()).toBe(1);
});

test('two workspaces get two floors', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  await floors.acquire('/w/one');
  await floors.acquire('/w/two');

  expect(spy.constructed.sort()).toEqual(['/w/one', '/w/two']);
  expect([...floors.workspaces()].sort()).toEqual(['/w/one', '/w/two']);
});

test('a floor is disposed when its LAST session releases it, and not before', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  const first = await floors.acquire('/w/one');
  const second = await floors.acquire('/w/one');

  first.release();
  await settle();
  expect(spy.disposed).toEqual([]);
  expect(floors.size()).toBe(1);

  second.release();
  await settle();
  expect(spy.disposed).toEqual(['/w/one']);
  expect(floors.size()).toBe(0);
});

test('releasing twice drops one reference, not two', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  const first = await floors.acquire('/w/one');
  const second = await floors.acquire('/w/one');

  first.release();
  first.release();
  await settle();
  // The second lease is still holding it: a double release must not take a
  // floor out from under a session that is still using it.
  expect(spy.disposed).toEqual([]);

  second.release();
  await settle();
  expect(spy.disposed).toEqual(['/w/one']);
});

test('a workspace acquired again after its floor went away is composed fresh', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  (await floors.acquire('/w/one')).release();
  await settle();
  await floors.acquire('/w/one');

  expect(spy.constructed).toEqual(['/w/one', '/w/one']);
});

test('two simultaneous acquires share ONE construction rather than racing two', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);
  const release = spy.hold();

  const both = Promise.all([floors.acquire('/w/one'), floors.acquire('/w/one')]);
  release();
  const [first, second] = await both;

  // Two provider-discovery passes for one workspace is exactly what the cache
  // exists to prevent, and a race would produce them.
  expect(spy.constructed).toEqual(['/w/one']);
  expect(first.floor).toBe(second.floor);
});

test('disposing the cache disposes every floor and refuses new ones', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  await floors.acquire('/w/one');
  await floors.acquire('/w/two');
  await floors.dispose();

  expect(spy.disposed.sort()).toEqual(['/w/one', '/w/two']);
  expect(floors.size()).toBe(0);
  await expect(floors.acquire('/w/three')).rejects.toThrow(/disposed/);
});

test('a floor whose disposal throws is dropped from the cache anyway', async () => {
  const floors = new HostedWorkspaceFloors(async ({ workspaceRoot }) => ({
    services: { workingDirectory: workspaceRoot } as unknown as ClientRuntimeServices,
    dispose: (): void => { throw new Error('a watcher would not let go'); },
  }));

  const lease = await floors.acquire('/w/one');
  lease.release();
  await settle();

  // The leak is named in the log; it must not keep a dead entry alive in the
  // cache, or the next acquire hands out a floor that was already torn down.
  expect(floors.size()).toBe(0);
});
