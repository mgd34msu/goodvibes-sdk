/**
 * test-child-watchdog-env.ts — the names the runner and its child agree on.
 *
 * Deliberately its own file, and deliberately importing nothing.
 *
 * `scripts/test-child-watchdog.ts` imports `bun:test` and registers a
 * `beforeEach`, because that is how it reports progress from inside the suite.
 * `scripts/owned-test-child.ts` runs in the PARENT, which is an ordinary
 * script — it needs these two variable names and must not acquire a `bun:test`
 * import (and a global lifecycle hook) to get them. Constants in the file that
 * installs the hooks would have handed it exactly that.
 */

/** Where the parent records its own pid, for the child's death probe. */
export const PARENT_PID_ENV = 'GOODVIBES_TEST_PARENT_PID';

/** Where the child writes its "a test started" heartbeat. */
export const HEARTBEAT_PATH_ENV = 'GOODVIBES_TEST_HEARTBEAT';

/** Exit code the child uses when it finds it has outlived its parent. */
export const PARENT_GONE_EXIT_CODE = 70;
