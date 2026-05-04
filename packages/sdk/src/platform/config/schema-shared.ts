/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export interface ConfigSettingDefinition {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'enum';
  default: unknown;
  description: string;
  enumValues?: string[] | undefined;
  validate?: ((value: unknown) => boolean) | undefined | undefined;
}
