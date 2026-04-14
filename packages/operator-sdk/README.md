# @pellux/goodvibes-operator-sdk

Contract-driven HTTP client for the GoodVibes operator and control-plane APIs.

Install:

```bash
npm install @pellux/goodvibes-operator-sdk
```

```ts
import { createOperatorSdk } from '@pellux/goodvibes-operator-sdk';

const operator = createOperatorSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});

const snapshot = await operator.control.snapshot();
const login = await operator.invoke('control.auth.login', {
  username: 'alice',
  password: 'secret',
});
```

Use this package when you want only the operator/control-plane surface and do not need the umbrella SDK composition layer.
