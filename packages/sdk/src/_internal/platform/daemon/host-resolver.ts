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
  switch (hostMode) {
    case 'local':
      return { host: '127.0.0.1', port: DEFAULT_PORTS[serverType] };
    case 'network':
      return { host: '0.0.0.0', port: DEFAULT_PORTS[serverType] };
    case 'custom':
      return { host: customHost || '127.0.0.1', port: customPort || DEFAULT_PORTS[serverType] };
  }
}
