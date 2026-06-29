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
export function port(): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535,
    validationHint: 'integer port in [1, 65535]',
  };
}
