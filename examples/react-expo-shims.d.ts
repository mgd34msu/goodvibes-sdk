declare module 'react' {
  export function useEffect(effect: () => void | undefined | (() => void), deps?: readonly unknown[]): void;
}

