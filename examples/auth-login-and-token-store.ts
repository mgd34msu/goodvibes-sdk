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
  username: (process.env.GOODVIBES_USERNAME ?? (() => { throw new Error('GOODVIBES_USERNAME env var is required'); })()) as string,
  password: (process.env.GOODVIBES_PASSWORD ?? (() => { throw new Error('GOODVIBES_PASSWORD env var is required'); })()) as string,
});

console.log('login succeeded', login.authenticated);
console.log('persisted token present', Boolean(await sdk.auth.getToken()));
console.log('current auth', await sdk.auth.current());
