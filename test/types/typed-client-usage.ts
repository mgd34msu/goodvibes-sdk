import {
  createGoodVibesSdk,
  createMemoryTokenStore,
  type GoodVibesCurrentAuth,
  type GoodVibesLoginOutput,
} from '@pellux/goodvibes-sdk';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
} from '@pellux/goodvibes-sdk/contracts';
import { createOperatorSdk } from '@pellux/goodvibes-sdk/operator';
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

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

  const knowledgeAskMethodId: OperatorTypedMethodId = 'knowledge.ask';
  const refinementTasksMethodId: OperatorTypedMethodId = 'knowledge.refinement.tasks.list';
  const knowledgeAskInput: OperatorMethodInput<'knowledge.ask'> = {
    query: 'what features does the TV have?',
    includeSources: true,
    includeLinkedObjects: true,
  };
  const knowledgeAskOutput = await sdk.operator.invoke(knowledgeAskMethodId, knowledgeAskInput);
  const typedKnowledgeAskOutput: OperatorMethodOutput<'knowledge.ask'> = knowledgeAskOutput;
  const refinementTasksOutput = await sdk.operator.invoke(refinementTasksMethodId);
  const typedRefinementTasksOutput: OperatorMethodOutput<'knowledge.refinement.tasks.list'> = refinementTasksOutput;

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
  void typedKnowledgeAskOutput;
  void typedRefinementTasksOutput;
  void challenge;
}

void verifyTypedSdkSurface;

// Verify well-known disposal symbols (using declarations — ES2025 / TC39 explicit resource management)
{
  using operatorSdk = createOperatorSdk({ baseUrl: 'http://127.0.0.1:3210' });
  using peerSdk = createPeerSdk({ baseUrl: 'http://127.0.0.1:3210' });
  void operatorSdk;
  void peerSdk;
}
