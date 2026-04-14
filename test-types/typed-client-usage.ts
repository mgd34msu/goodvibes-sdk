import {
  createGoodVibesSdk,
  createMemoryTokenStore,
  type GoodVibesCurrentAuth,
  type GoodVibesLoginOutput,
} from '@goodvibes/sdk';

async function verifyTypedSdkSurface(): Promise<void> {
  const sdk = createGoodVibesSdk({
    baseUrl: 'http://127.0.0.1:3210',
    tokenStore: createMemoryTokenStore(),
  });

  const login: GoodVibesLoginOutput = await sdk.auth.login({
    username: 'alice',
    password: 'secret',
  });
  const token: string = login.token;

  const current: GoodVibesCurrentAuth = await sdk.auth.current();
  const authenticated: boolean = current.authenticated;

  const currentViaOperator = await sdk.operator.control.auth.current();
  const currentPrincipalId: string | null = currentViaOperator.principalId;

  const typedInvokeLogin = await sdk.operator.invoke('control.auth.login', {
    username: 'alice',
    password: 'secret',
  });
  const typedInvokeToken: string = typedInvokeLogin.token;

  const pairRequest = await sdk.peer.invoke('pair.request', {
    peerKind: 'node',
    label: 'Pixel companion',
    requestedId: 'device-1',
  });
  const challenge: string = pairRequest.challenge;

  void token;
  void authenticated;
  void currentPrincipalId;
  void typedInvokeToken;
  void challenge;
}

void verifyTypedSdkSurface;
