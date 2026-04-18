// Synced from packages/contracts/src/zod-schemas/auth.ts
import { z } from 'zod/v4';

/**
 * Schema for `control.auth.login` response.
 *
 * Matches `OperatorMethodOutputMap["control.auth.login"]`.
 */
export const ControlAuthLoginResponseSchema = z.object({
  authenticated: z.boolean(),
  token: z.string(),
  username: z.string(),
  expiresAt: z.number(),
});

export type ControlAuthLoginResponse = z.infer<typeof ControlAuthLoginResponseSchema>;

/**
 * Schema for `control.auth.current` response.
 *
 * Matches `OperatorMethodOutputMap["control.auth.current"]`.
 */
export const ControlAuthCurrentResponseSchema = z.object({
  authenticated: z.boolean(),
  authMode: z.enum(['anonymous', 'invalid', 'session', 'shared-token']),
  tokenPresent: z.boolean(),
  authorizationHeaderPresent: z.boolean(),
  sessionCookiePresent: z.boolean(),
  principalId: z.string().nullable(),
  principalKind: z.enum(['bot', 'service', 'token', 'user']).nullable(),
  admin: z.boolean(),
  scopes: z.array(z.string()),
  roles: z.array(z.string()),
});

export type ControlAuthCurrentResponse = z.infer<typeof ControlAuthCurrentResponseSchema>;
