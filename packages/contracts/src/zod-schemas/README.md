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

## Contract-Typed Surfaces

The following surfaces are validated through their generated TypeScript
contract definitions and the transport envelope instead of dedicated reusable
Zod exports:

- `sessions.create` / `sessions.get` / `sessions.list` — session output
  shapes vary by surface configuration.
- `control.snapshot` — large nested shape with many optional fields.
- `control.contract` — describes the contract manifest itself.
- `automation.*`, `knowledge.*`, and `channels.*` outputs — extension and
  plugin-driven shapes that stay aligned through the generated contract
  artifacts.

## Import Path

```ts
import { ControlAuthLoginResponseSchema } from '@pellux/goodvibes-contracts/zod-schemas/index';
// or
import { ControlAuthLoginResponseSchema } from '@pellux/goodvibes-contracts';
```
