# Zod Schemas

Runtime Zod v4 schemas derived from the GoodVibes contract definitions.

## Implemented

| Schema | Method | File |
|--------|--------|------|
| `ControlAuthLoginResponseSchema` | `control.auth.login` | `auth.ts` |
| `ControlAuthCurrentResponseSchema` | `control.auth.current` | `auth.ts` |
| `AccountsSnapshotResponseSchema` | `accounts.snapshot` | `accounts.ts` |
| `ControlStatusResponseSchema` | `control.status` | `session.ts` |
| `LocalAuthStatusResponseSchema` | `local_auth.status` | `session.ts` |
| `SerializedEventEnvelopeSchema` | SSE/WS envelope | `events.ts` |
| `TypedSerializedEventEnvelopeSchema` | SSE/WS typed envelope | `events.ts` |

## Deferred

The following surfaces are deferred pending type stabilization:

- `sessions.create` / `sessions.get` / `sessions.list` — session output shapes vary by surface configuration; will be added post-1.0 once session shape is locked.
- `control.snapshot` — large nested shape with many optional fields; correctness requires generated schema tooling.
- `control.contract` — describes the contract manifest itself; circular definition risk; deferred to Wave 8.
- All `automation.*`, `knowledge.*`, `channels.*` outputs — plugin-generated shapes that may diverge from typed contracts; deferred to Wave 8 schema coverage pass.

## Import Path

```ts
import { ControlAuthLoginResponseSchema } from '@pellux/goodvibes-contracts/zod-schemas/index';
// or
import { ControlAuthLoginResponseSchema } from '@pellux/goodvibes-contracts';
```
