import { isAcceptableReasoningEffortSetting } from '../providers/reasoning-effort.js';
/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export interface ConfigSettingDefinition {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'enum';
  default: unknown;
  description: string;
  enumValues?: string[] | undefined;
  validate?: ((value: unknown) => boolean) | undefined;
  /**
   * Optional hint appended to the validation-failure message when `validate`
   * returns false. Use to tell callers the accepted range or format,
   * e.g. `'finite number in [0.25, 4.0]'`.
   */
  validationHint?: string | undefined;
}

/**
 * Returns validate + validationHint for `provider.reasoningEffort`.
 *
 * Not an enum: which reasoning levels exist is per model, and the former
 * four-value list rejected `none`, `minimal`, `xhigh` and `max`, all real
 * levels on models shipping today. Validation runs against the levels the
 * CURRENT model resolved to once the runtime has published them, and against
 * the known severity ladder before that, so a typo is still caught here rather
 * than by a provider.
 */
export function reasoningEffortSetting(): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: isAcceptableReasoningEffortSetting,
    validationHint: 'a reasoning level the current model supports — run /effort to list them',
  };
}

/** Returns validate + validationHint for an integer in [min, max]. */
export function intRange(
  min: number,
  max: number,
): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max,
    validationHint: `integer in [${min}, ${max}]`,
  };
}

/** Returns validate + validationHint for a float in [min, max]. */
export function numRange(
  min: number,
  max: number,
): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && v >= min && v <= max,
    validationHint: `number in [${min}, ${max}]`,
  };
}

/** Returns validate + validationHint for a TCP port (integer in [1, 65535]). */
/**
 * The hint every port setting carries.
 *
 * Exported because it is the only structural mark a port has: cluster config
 * replication reads it to refuse to replicate ANY port, and a shared constant
 * is what keeps that refusal true when a new port setting is added.
 */
export const PORT_VALIDATION_HINT = 'integer port in [1, 65535]';

export function port(): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535,
    validationHint: PORT_VALIDATION_HINT,
  };
}
