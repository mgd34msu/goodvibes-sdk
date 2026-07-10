/**
 * workspace-registration.test.ts
 *
 * The shared registered-workspace registry: the pure path→coverage resolver
 * (coverage-down-subtree, nearest-root-wins, subtree-scoped declines, and the
 * load-bearing worktree→main-repo LINK inheritance), the user-scoped store with
 * its broad-root guard, the injectable worktree-link probe, and the four
 * operator verbs (list/add/remove + resolve) over a real GatewayMethodCatalog
 * plus their advertised REST routes.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerWorkspacesGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/workspaces.ts';
import { GATEWAY_REST_ROUTES } from '../packages/daemon-sdk/src/gateway-rest-routes.ts';
import {
  WorkspaceRegistrationStore,
  resolveWorkspaceRegistration,
  probeWorktreeLink,
  type GitRunner,
  type RegisteredWorkspaceRecord,
  type DeclinedWorkspaceRecord,
} from '../packages/sdk/src/platform/workspace/registration/index.ts';

const HOME = '/home/dev';
const STATE = '/home/dev/.goodvibes';

function reg(root: string): RegisteredWorkspaceRecord {
  return { root, registeredAt: '2026-07-10T00:00:00.000Z' };
}
function decl(root: string): DeclinedWorkspaceRecord {
  return { root, declinedAt: '2026-07-10T00:00:00.000Z' };
}

describe('resolveWorkspaceRegistration — pure semantics', () => {
  test('coverage flows DOWN a registered root subtree, never up', () => {
    const registrations = [reg('/home/dev/proj')];
    // A descendant is covered.
    expect(
      resolveWorkspaceRegistration({ path: '/home/dev/proj/src/app', registrations, declines: [] }).status,
    ).toBe('covered');
    // The root itself is covered.
    expect(resolveWorkspaceRegistration({ path: '/home/dev/proj', registrations, declines: [] }).status).toBe(
      'covered',
    );
    // A PARENT of the registered root is NOT covered (no upward flow).
    expect(resolveWorkspaceRegistration({ path: '/home/dev', registrations, declines: [] }).status).toBe(
      'unknown',
    );
    // A sibling is not covered.
    expect(resolveWorkspaceRegistration({ path: '/home/dev/other', registrations, declines: [] }).status).toBe(
      'unknown',
    );
  });

  test('a path prefix that is not a path-segment boundary does NOT count as covered', () => {
    // /home/dev/proj must not cover /home/dev/proj-two.
    const res = resolveWorkspaceRegistration({
      path: '/home/dev/proj-two',
      registrations: [reg('/home/dev/proj')],
      declines: [],
    });
    expect(res.status).toBe('unknown');
  });

  test('nearest (deepest) registered root wins when registrations nest', () => {
    const registrations = [reg('/home/dev/proj'), reg('/home/dev/proj/packages/api')];
    const res = resolveWorkspaceRegistration({
      path: '/home/dev/proj/packages/api/src',
      registrations,
      declines: [],
    });
    expect(res.status).toBe('covered');
    expect(res.coveredBy).toBe('/home/dev/proj/packages/api');
  });

  test('declines are subtree-scoped at the asked root', () => {
    const res = resolveWorkspaceRegistration({
      path: '/home/dev/proj/src',
      registrations: [],
      declines: [decl('/home/dev/proj')],
    });
    expect(res.status).toBe('declined');
    expect(res.declinedRoot).toBe('/home/dev/proj');
  });

  test('a nearer registration overrides a broader decline; a tie resolves to covered', () => {
    // Registered the specific project, declined its parent → covered wins (nearer).
    expect(
      resolveWorkspaceRegistration({
        path: '/home/dev/proj/src',
        registrations: [reg('/home/dev/proj')],
        declines: [decl('/home/dev')],
      }).status,
    ).toBe('covered');
    // Same root registered AND declined → covered wins the tie.
    expect(
      resolveWorkspaceRegistration({
        path: '/home/dev/proj/src',
        registrations: [reg('/home/dev/proj')],
        declines: [decl('/home/dev/proj')],
      }).status,
    ).toBe('covered');
    // A nearer decline than the registration → declined wins for that subtree.
    expect(
      resolveWorkspaceRegistration({
        path: '/home/dev/proj/secret/x',
        registrations: [reg('/home/dev/proj')],
        declines: [decl('/home/dev/proj/secret')],
      }).status,
    ).toBe('declined');
  });

  test('WORKTREE LINK: a sibling worktree OUTSIDE the registered subtree inherits via the main-repo link', () => {
    // The registered root is the main project; the worktree lives under /tmp,
    // entirely outside the project subtree — path ancestry alone would miss it.
    const res = resolveWorkspaceRegistration({
      path: '/tmp/orchestration/wt/item-3',
      git: { mainWorktreeRoot: '/home/dev/proj' },
      registrations: [reg('/home/dev/proj')],
      declines: [],
    });
    expect(res.status).toBe('covered');
    expect(res.coveredBy).toBe('/home/dev/proj');
    expect(res.viaWorktreeLink).toBe(true);
  });

  test('WORKTREE LINK: no inheritance when the main repo is not registered', () => {
    const res = resolveWorkspaceRegistration({
      path: '/tmp/wt/item-1',
      git: { mainWorktreeRoot: '/home/dev/unregistered' },
      registrations: [reg('/home/dev/proj')],
      declines: [],
    });
    expect(res.status).toBe('unknown');
    expect(res.viaWorktreeLink).toBe(false);
  });

  test('direct path coverage is preferred over link coverage (viaWorktreeLink false)', () => {
    const res = resolveWorkspaceRegistration({
      path: '/home/dev/proj/wt',
      git: { mainWorktreeRoot: '/home/dev/proj' },
      registrations: [reg('/home/dev/proj')],
      declines: [],
    });
    expect(res.status).toBe('covered');
    expect(res.viaWorktreeLink).toBe(false);
  });
});

describe('probeWorktreeLink — worktree→main-repo link resolution', () => {
  test('a linked worktree reports the MAIN worktree root from --git-common-dir, not path ancestry', () => {
    // Simulate: worktree at /tmp/wt/item, main repo at /home/dev/proj.
    const runner: GitRunner = (_cwd, args) => {
      if (args.includes('--git-common-dir')) return '/home/dev/proj/.git';
      if (args.includes('--show-toplevel')) return '/tmp/wt/item';
      return null;
    };
    expect(probeWorktreeLink('/tmp/wt/item', runner)).toEqual({ mainWorktreeRoot: '/home/dev/proj' });
  });

  test('the MAIN worktree itself yields no inheritance (common dir parent === toplevel)', () => {
    const runner: GitRunner = (_cwd, args) => {
      if (args.includes('--git-common-dir')) return '/home/dev/proj/.git';
      if (args.includes('--show-toplevel')) return '/home/dev/proj';
      return null;
    };
    expect(probeWorktreeLink('/home/dev/proj', runner)).toEqual({});
  });

  test('a non-repo path yields no metadata', () => {
    const runner: GitRunner = () => null;
    expect(probeWorktreeLink('/tmp/plain', runner)).toEqual({});
  });

  test('a bare repo (common dir is not a .git directory) yields no main worktree', () => {
    const runner: GitRunner = (_cwd, args) => {
      if (args.includes('--git-common-dir')) return '/srv/repos/thing.git';
      if (args.includes('--show-toplevel')) return null;
      return null;
    };
    expect(probeWorktreeLink('/srv/repos/thing.git', runner)).toEqual({});
  });
});

describe('WorkspaceRegistrationStore — persistence + broad-root guard', () => {
  function store(probe?: (p: string) => { mainWorktreeRoot?: string }): WorkspaceRegistrationStore {
    return new WorkspaceRegistrationStore({
      path: ':memory:',
      homeDir: HOME,
      daemonStateDir: STATE,
      probe: probe ?? (() => ({})),
    });
  }

  test('add normalizes a trailing separator and is idempotent on the normalized root', async () => {
    const s = store();
    const first = await s.add('/home/dev/proj/');
    expect(first.alreadyRegistered).toBe(false);
    expect(first.record.root).toBe('/home/dev/proj');
    const second = await s.add('/home/dev/proj');
    expect(second.alreadyRegistered).toBe(true);
    expect((await s.snapshot()).workspaces).toHaveLength(1);
  });

  test('a fresh registration clears a remembered decline at that exact root', async () => {
    const s = store();
    await s.decline('/home/dev/proj');
    expect((await s.snapshot()).declines).toHaveLength(1);
    await s.add('/home/dev/proj');
    expect((await s.snapshot()).declines).toHaveLength(0);
  });

  test('remove returns an honest boolean', async () => {
    const s = store();
    await s.add('/home/dev/proj');
    expect((await s.remove('/home/dev/proj')).removed).toBe(true);
    expect((await s.remove('/home/dev/proj')).removed).toBe(false);
  });

  test('the broad-root guard refuses HOME, the filesystem root, and the daemon state dir', async () => {
    const s = store();
    for (const bad of [HOME, '/', STATE]) {
      await expect(s.add(bad)).rejects.toThrow(/refusing to register/);
    }
    // A normal project root is accepted.
    await expect(s.add('/home/dev/proj')).resolves.toBeDefined();
  });

  test('resolve threads the injected probe so a linked worktree inherits registration', async () => {
    const s = store((p) => (p.startsWith('/tmp/wt') ? { mainWorktreeRoot: '/home/dev/proj' } : {}));
    await s.add('/home/dev/proj');
    const res = await s.resolve('/tmp/wt/item');
    expect(res.status).toBe('covered');
    expect(res.viaWorktreeLink).toBe(true);
  });
});

describe('workspaces.* gateway verbs', () => {
  function makeCatalog(): GatewayMethodCatalog {
    const catalog = new GatewayMethodCatalog();
    const s = new WorkspaceRegistrationStore({
      path: ':memory:',
      homeDir: HOME,
      daemonStateDir: STATE,
      probe: (p) => (p.startsWith('/tmp/wt') ? { mainWorktreeRoot: '/home/dev/proj' } : {}),
    });
    registerWorkspacesGatewayMethods(catalog, s);
    return catalog;
  }
  const ctx = { context: { admin: true } } as const;

  test('all four verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog();
    for (const id of [
      'workspaces.registrations.list',
      'workspaces.registrations.add',
      'workspaces.registrations.remove',
      'workspaces.resolve',
    ]) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('add -> list -> resolve -> remove round-trips through the catalog', async () => {
    const catalog = makeCatalog();

    const added = (await catalog.invoke('workspaces.registrations.add', {
      ...ctx,
      body: { root: '/home/dev/proj', label: 'main' },
    })) as { workspace: { root: string; label?: string }; alreadyRegistered: boolean };
    expect(added.workspace.root).toBe('/home/dev/proj');
    expect(added.alreadyRegistered).toBe(false);

    const listed = (await catalog.invoke('workspaces.registrations.list', { ...ctx, body: {} })) as {
      workspaces: { root: string }[];
    };
    expect(listed.workspaces.map((w) => w.root)).toEqual(['/home/dev/proj']);

    const resolved = (await catalog.invoke('workspaces.resolve', {
      ...ctx,
      body: { path: '/tmp/wt/item' },
    })) as { status: string; viaWorktreeLink: boolean };
    expect(resolved.status).toBe('covered');
    expect(resolved.viaWorktreeLink).toBe(true);

    const removed = (await catalog.invoke('workspaces.registrations.remove', {
      ...ctx,
      body: { root: '/home/dev/proj' },
    })) as { removed: boolean };
    expect(removed.removed).toBe(true);
  });

  test('registering a broad root surfaces an honest 400', async () => {
    const catalog = makeCatalog();
    const error = await catalog
      .invoke('workspaces.registrations.add', { ...ctx, body: { root: HOME } })
      .catch((e: unknown) => e as { status?: number });
    expect(error.status).toBe(400);
  });
});

describe('workspaces.* REST parity', () => {
  test('every workspaces verb has a route in GATEWAY_REST_ROUTES', () => {
    const routed = new Set(GATEWAY_REST_ROUTES.map((r) => r.methodId));
    for (const id of [
      'workspaces.registrations.list',
      'workspaces.registrations.add',
      'workspaces.registrations.remove',
      'workspaces.resolve',
    ]) {
      expect(routed.has(id)).toBe(true);
    }
  });
});
