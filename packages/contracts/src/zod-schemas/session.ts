import { z } from 'zod/v4';

/**
 * Minimal schema for `control.status` response.
 *
 * Matches `OperatorMethodOutputMap["control.status"]`.
 */
export const ControlStatusResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
});

export type ControlStatusResponse = z.infer<typeof ControlStatusResponseSchema>;

/**
 * Minimal schema for `local_auth.status` response.
 *
 * Matches `OperatorMethodOutputMap["local_auth.status"]`.
 */
export const LocalAuthStatusResponseSchema = z.object({
  enabled: z.boolean().optional(),
  bootstrapped: z.boolean().optional(),
}).catchall(z.unknown());

export type LocalAuthStatusResponse = z.infer<typeof LocalAuthStatusResponseSchema>;
