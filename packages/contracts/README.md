# @pellux/goodvibes-contracts

Public runtime-neutral GoodVibes contract package for operator and peer artifacts, generated ids, lookup helpers, and schema exports.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/contracts`. Install this package directly when you only need the contracts subset.

Consumer import:

```ts
import {
  getOperatorContract,
  getOperatorMethod,
  type OperatorMethodOutput,
} from '@pellux/goodvibes-sdk/contracts';
```

This surface provides:
- operator contract lookup
- peer contract lookup
- operator method ids
- peer endpoint ids
- runtime event domains
- generated method, endpoint, and event payload types

Example:

```ts
import {
  getOperatorContract,
  getOperatorMethod,
  type OperatorMethodOutput,
} from '@pellux/goodvibes-sdk/contracts';

const contract = getOperatorContract();
const loginMethod = getOperatorMethod('control.auth.login');
type LoginOutput = OperatorMethodOutput<'control.auth.login'>;
```

Peer example:

```ts
import {
  getPeerContract,
  getPeerEndpoint,
  listPeerEndpoints,
} from '@pellux/goodvibes-sdk/contracts';

const peerContract = getPeerContract();
const pairEndpoint = getPeerEndpoint('pair.request');
const allEndpoints = listPeerEndpoints();
```

Lookup and guard helpers:

```ts
import {
  listOperatorMethods,
  isOperatorMethodId,
  isPeerEndpointId,
  RUNTIME_EVENT_DOMAINS,
  isRuntimeEventDomain,
} from '@pellux/goodvibes-sdk/contracts';

listOperatorMethods(); // readonly OperatorMethodContract[]
isOperatorMethodId('control.auth.login'); // true
isPeerEndpointId('pair.request'); // true
RUNTIME_EVENT_DOMAINS.forEach((domain) => isRuntimeEventDomain(domain));
```

Node-only artifact path helpers:

```ts
import {
  getOperatorContractPath,
  getPeerContractPath,
} from '@pellux/goodvibes-sdk/contracts/node';
```

When installing this package directly instead of the SDK facade, import from
`@pellux/goodvibes-contracts` and `@pellux/goodvibes-contracts/node`:

```ts
import { getOperatorContract, getPeerContract } from '@pellux/goodvibes-contracts';
import { getOperatorContractPath, getPeerContractPath } from '@pellux/goodvibes-contracts/node';
```

See the [zod-schemas README](./src/zod-schemas/README.md) for the runtime Zod
schema exports re-exported from this package root.
