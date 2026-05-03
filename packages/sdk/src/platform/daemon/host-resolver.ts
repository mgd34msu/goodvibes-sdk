export interface ResolvedHostBinding {
  readonly host: string;
  readonly port: number;
}

const DEFAULT_PORTS = {
  controlPlane: 3421,
  httpListener: 3422,
  web: 3423,
} as const;

export function resolveHostBinding(
  hostMode: 'local' | 'network' | 'custom',
  customHost: string,
  customPort: number,
  serverType: 'controlPlane' | 'httpListener' | 'web',
): ResolvedHostBinding {
  // hostMode decides the bind address. Port is always caller-controlled — a
  // configured customPort takes precedence, and only falls back to the
  // server-type default when unset/zero. Reverting this rule would force every
  // localhost-bound test/dev setup into 'custom' mode.
  const port = customPort || DEFAULT_PORTS[serverType];
  switch (hostMode) {
    case 'local':
      return { host: '127.0.0.1', port };
    case 'network':
      return { host: '0.0.0.0', port };
    case 'custom':
      return { host: customHost || '127.0.0.1', port };
  }
}
