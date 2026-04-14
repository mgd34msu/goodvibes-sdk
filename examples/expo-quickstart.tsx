import { useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

export default function App() {
  useEffect(() => {
    let stop = () => {};

    void (async () => {
      const token = await SecureStore.getItemAsync('goodvibes_token');
      const sdk = createExpoGoodVibesSdk({
        baseUrl: 'https://goodvibes.example.com',
        authToken: token,
      });

      const snapshot = await sdk.operator.control.snapshot();
      console.log(snapshot);

      stop = sdk.realtime.runtime().agents.on('AGENT_COMPLETED', (event) => {
        console.log('agent completed', event);
      });
    })();

    return () => {
      stop();
    };
  }, []);

  return null;
}
