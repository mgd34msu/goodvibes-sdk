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

Node-only artifact path helpers:

```ts
import { getOperatorContractPath } from '@pellux/goodvibes-sdk/contracts/node';
```
