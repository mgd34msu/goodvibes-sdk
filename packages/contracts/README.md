# @pellux/goodvibes-contracts

Runtime-neutral GoodVibes contract artifacts, ids, and generated typed request/response/event maps.

Install:

```bash
npm install @pellux/goodvibes-contracts
```

Use this package for:
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
} from '@pellux/goodvibes-contracts';

const contract = getOperatorContract();
const loginMethod = getOperatorMethod('control.auth.login');
type LoginOutput = OperatorMethodOutput<'control.auth.login'>;
```

Node-only artifact path helpers:

```ts
import { getOperatorContractPath } from '@pellux/goodvibes-contracts/node';
```

Use `@pellux/goodvibes-contracts` when you are building typed tooling, custom clients, or daemon hosts against the GoodVibes platform contracts.
