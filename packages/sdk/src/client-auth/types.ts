import type {
  OperatorMethodInput,
  OperatorMethodOutput,
} from '@pellux/goodvibes-contracts';

export type GoodVibesCurrentAuth = OperatorMethodOutput<'control.auth.current'>;
export type GoodVibesLoginInput = OperatorMethodInput<'control.auth.login'>;
export type GoodVibesLoginOutput = OperatorMethodOutput<'control.auth.login'>;

export interface GoodVibesTokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string | null): Promise<void>;
  clearToken(): Promise<void>;
  getTokenEntry?(): Promise<{ token: string | null; expiresAt?: number }>;
  setTokenEntry?(token: string | null, expiresAt?: number): Promise<void>;
}

export interface GoodVibesAuthLoginOptions {
  readonly persistToken?: boolean | undefined;
}
