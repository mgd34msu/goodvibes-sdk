# The webui re-pin now enforces required fields it never enforced before

Date: 2026-07-28
Status: accepted, action required at the webui re-pin, not here

`goodvibes-webui/src/lib/goodvibes.ts`'s `invokeGatewayMethod` is typed
`body?: OperatorMethodInput<TMethodId>`, and its own comment records that it
relies on that family resolving to the permissive `{ [k: string]: unknown }`
fallback, which it did for every id that had no entry in
`OperatorMethodInputMap`.

Every catalogued verb now has a rendered entry. The fallback is gone, so those
inputs carry their real shapes and their real `required` arrays.

## What must be checked at the re-pin

Measured against this branch's generated map, not estimated. `invokeGatewayMethod`
has **41 call sites** covering **33 distinct method ids**; **22 of those ids now
enforce at least one required field**:

| method id | fields now required |
|---|---|
| `checkpoints.create` | `kind` |
| `checkpoints.diff` | `a` |
| `checkpoints.restore` | `id` |
| `checkpoints.restorePreview` | `id` |
| `checkpoints.revertHunk` | `path`, `hunk` |
| `checkpoints.revertHunkPreview` | `path`, `hunk` |
| `cost.attribution.get` | `window`, `dimension` |
| `fleet.archive` | `id` |
| `fleet.attempts.judge` | `groupId` |
| `fleet.observed.steer` | `id`, `text` |
| `fleet.unarchive` | `id` |
| `pairing.handoff.complete` | `endpoint`, `keys`, `p256dh`, `auth`, `rpId`, `origin`, `credentialId`, `publicKeyCose` |
| `pairing.tokens.create` | `name` |
| `pairing.tokens.delete` | `id` |
| `pairing.tokens.migrate` | `name` |
| `pairing.tokens.rename` | `id`, `name` |
| `push.subscriptions.create` | `endpoint`, `keys`, `p256dh`, `auth` |
| `push.subscriptions.delete` | `subscriptionId` |
| `push.subscriptions.verify` | `subscriptionId` |
| `rewind.apply` | `sessionId`, `scope` |
| `rewind.plan` | `sessionId`, `scope` |
| `sessions.changes.get` | `sessionId` |

The remaining 11, `checkpoints.list`, `fleet.archived.list`,
`fleet.archiveFinished`, `fleet.list`, `fleet.snapshot`, `pairing.tokens.list`,
`push.subscriptions.list`, `push.vapid.get`, `sessions.search`,
`tailscale.get`, `tailscale.serve.run`, declare no required field. Checked
individually rather than inferred from the absence of an error: each is either
an empty input or all-optional.

**The action:** every bridge type in `goodvibes-webui/src/lib/contract-bridge-types.ts`
covering an id above must declare those fields required. A bridge that still
declares them optional will now be a compile error at the re-pin, which is the
wanted outcome, because the server was already refusing those calls; the webui
simply could not see it.

## A note on the numbers

An earlier estimate put this at "25 of 41". That counted call sites where this
counts distinct ids, and 41 is the call-site total. The table above is computed
from `packages/contracts/src/generated/foundation-client-types.ts` on this
branch by parsing the required (non-`?`) properties of each entry, so it is the
number to work from.

## Unrelated, and it will bite the next worktree

`bun install` fails in a fresh SDK worktree: exit 1, **no diagnostic**, and no
more output with `--verbose` or unsandboxed. The lane that hit it worked around
it by hardlink-copying `node_modules` from the main checkout
(`cp -al ../../goodvibes-sdk/node_modules node_modules`). Nobody has diagnosed
the cause. Anyone creating a worktree for this repo should expect it and reach
for the copy rather than spending time on the installer.
