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
| `RuntimeEventRecordSchema` | runtime event record | `events.ts` |
| `ProviderModelRefSchema` | model reference | `providers.ts` |
| `ProviderModelEntrySchema` | model catalog entry | `providers.ts` |
| `ConfiguredViaSchema` | provider auth source | `providers.ts` |
| `ProviderAuthRouteDescriptorSchema` | provider auth route | `providers.ts` |
| `ProviderModelProviderSchema` | provider catalog entry | `providers.ts` |
| `ListProviderModelsResponseSchema` | `GET /api/models` | `providers.ts` |
| `CurrentModelResponseSchema` | `GET /api/models/current` | `providers.ts` |
| `PatchCurrentModelBodySchema` | `PATCH /api/models/current` (request) | `providers.ts` |
| `PatchCurrentModelErrorSchema` | `PATCH /api/models/current` (error) | `providers.ts` |
| `PatchCurrentModelResponseSchema` | `PATCH /api/models/current` (response) | `providers.ts` |
| `ModelChangedEventSchema` | `model.changed` SSE event | `providers.ts` |

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

Per-file subpaths are also published for narrower imports:

```ts
import { AccountsSnapshotResponseSchema } from '@pellux/goodvibes-contracts/zod-schemas/accounts';
import { ControlAuthLoginResponseSchema } from '@pellux/goodvibes-contracts/zod-schemas/auth';
import { SerializedEventEnvelopeSchema } from '@pellux/goodvibes-contracts/zod-schemas/events';
import { ControlStatusResponseSchema } from '@pellux/goodvibes-contracts/zod-schemas/session';
import { ListProviderModelsResponseSchema } from '@pellux/goodvibes-contracts/zod-schemas/providers';
```

## See also

- Main SDK: [`@pellux/goodvibes-sdk`](../../../sdk/README.md)
- [Getting Started](../../../../docs/getting-started.md)
