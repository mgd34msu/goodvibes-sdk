declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}

declare module 'expo-secure-store' {
  export function getItemAsync(key: string): Promise<string | null>;
}
