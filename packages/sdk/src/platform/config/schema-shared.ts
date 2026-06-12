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
