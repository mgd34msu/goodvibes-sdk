export type RequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

export type MethodArgs<TInput, TOptions> =
  [TInput] extends [undefined]
    ? [input?: undefined, options?: TOptions]
    : TInput extends object
      ? [RequiredKeys<TInput>] extends [never]
        ? [input?: TInput, options?: TOptions]
        : [input: TInput, options?: TOptions]
      : [input: TInput, options?: TOptions];

export type WithoutKeys<TInput, TKeys extends PropertyKey> =
  [TInput] extends [undefined]
    ? undefined
    : TInput extends object
      ? Omit<TInput, Extract<keyof TInput, TKeys>>
      : TInput;

export function splitClientArgs<TInput, TOptions>(
  args: readonly [TInput?, TOptions?],
): readonly [TInput | undefined, TOptions | undefined] {
  return args as readonly [TInput | undefined, TOptions | undefined];
}
