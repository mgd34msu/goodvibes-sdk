/**
 * Login with the operator API and persist the returned token in memory.
 */
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const tokenStore = createMemoryTokenStore();

const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  tokenStore,
});

const login = await sdk.auth.login({
  username: process.env.GOODVIBES_USERNAME ?? '<set GOODVIBES_USERNAME>',
  password: process.env.GOODVIBES_PASSWORD ?? '<set GOODVIBES_PASSWORD>',
});

console.log('login succeeded', login.authenticated);
console.log('persisted token present', Boolean(await sdk.auth.getToken()));
console.log('current auth', await sdk.auth.current());
