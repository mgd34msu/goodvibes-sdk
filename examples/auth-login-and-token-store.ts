import {
  createGoodVibesSdk,
  createMemoryTokenStore,
} from '@goodvibes/sdk';

const tokenStore = createMemoryTokenStore();

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  tokenStore,
});

const login = await sdk.auth.login({
  username: 'alice',
  password: 'secret',
});

console.log('login token', login.token);
console.log('persisted token', await sdk.auth.getToken());
console.log('current auth', await sdk.auth.current());
