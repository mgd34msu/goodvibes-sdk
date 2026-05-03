import { createHookApi, type HookApi } from '../hooks/hook-api.js';

export function createRuntimeHookApi(options: Parameters<typeof createHookApi>[0]): HookApi {
  return createHookApi(options);
}
