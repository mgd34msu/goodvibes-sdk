# @pellux/goodvibes-contracts

Internal workspace package backing `@pellux/goodvibes-sdk/contracts`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

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
