export type GoodVibesRuntimeSurface =
  | 'client'
  | 'edge'
  | 'mobile'
  | 'node-runtime'
  | 'node-platform';

export type GoodVibesRuntimeRequirement =
  | 'fetch'
  | 'websocket'
  | 'node-like'
  | 'filesystem'
  | 'child-process'
  | 'local-database'
  | 'native-module'
  | 'provider-sdk'
  | 'browser-global'
  | 'secure-mobile-storage';

export interface GoodVibesRuntimeCapability {
  readonly id: string;
  readonly description: string;
  readonly entrypoints: readonly string[];
  readonly surfaces: readonly GoodVibesRuntimeSurface[];
  readonly requirements: readonly GoodVibesRuntimeRequirement[];
  readonly dependencyFamilies: readonly string[];
}

export const GOODVIBES_CLIENT_SAFE_ENTRYPOINTS = [
  '@pellux/goodvibes-sdk',
  '@pellux/goodvibes-sdk/browser',
  '@pellux/goodvibes-sdk/web',
  '@pellux/goodvibes-sdk/workers',
  '@pellux/goodvibes-sdk/react-native',
  '@pellux/goodvibes-sdk/expo',
] as const;

export const GOODVIBES_NODE_RUNTIME_ENTRYPOINTS = [
  '@pellux/goodvibes-sdk/platform',
  '@pellux/goodvibes-sdk/platform/index',
  '@pellux/goodvibes-sdk/platform/node',
  '@pellux/goodvibes-sdk/platform/node/index',
  '@pellux/goodvibes-sdk/platform/runtime',
  '@pellux/goodvibes-sdk/platform/knowledge',
  '@pellux/goodvibes-sdk/platform/providers',
  '@pellux/goodvibes-sdk/platform/tools',
  '@pellux/goodvibes-sdk/platform/integrations',
] as const;

export const GOODVIBES_RUNTIME_CAPABILITIES: readonly GoodVibesRuntimeCapability[] = [
  {
    id: 'remote-client',
    description: 'HTTP, realtime, operator, peer, and auth clients for talking to an existing daemon.',
    entrypoints: GOODVIBES_CLIENT_SAFE_ENTRYPOINTS,
    surfaces: ['client', 'edge', 'mobile'],
    requirements: ['fetch', 'websocket'],
    dependencyFamilies: [
      '@pellux/goodvibes-transport-*',
      '@pellux/goodvibes-operator-sdk',
      '@pellux/goodvibes-peer-sdk',
    ],
  },
  {
    id: 'worker-proxy',
    description: 'Cloudflare Worker proxy and queue helpers for forwarding daemon batch work.',
    entrypoints: ['@pellux/goodvibes-sdk/workers'],
    surfaces: ['edge'],
    requirements: ['fetch'],
    dependencyFamilies: [],
  },
  {
    id: 'local-runtime',
    description: 'Runtime stores, diagnostics, transports, bootstrap helpers, and local host services.',
    entrypoints: [
      '@pellux/goodvibes-sdk/platform',
      '@pellux/goodvibes-sdk/platform/index',
      '@pellux/goodvibes-sdk/platform/runtime',
      '@pellux/goodvibes-sdk/platform/node',
      '@pellux/goodvibes-sdk/platform/node/index',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: ['sql.js', 'sqlite-vec'],
  },
  {
    id: 'knowledge-system',
    description: 'Knowledge spaces, ingestion, extraction, graph storage, semantic enrichment, generated pages, and extensions.',
    entrypoints: [
      '@pellux/goodvibes-sdk/platform',
      '@pellux/goodvibes-sdk/platform/index',
      '@pellux/goodvibes-sdk/platform/knowledge',
      '@pellux/goodvibes-sdk/platform/node',
      '@pellux/goodvibes-sdk/platform/node/index',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: [
      'pdfjs-dist',
      'jsdom',
      '@mozilla/readability',
      'jszip',
      'graphql',
      'bplist-parser',
    ],
  },
  {
    id: 'provider-integrations',
    description: 'LLM, voice, multimodal, provider registry, and provider auth integrations.',
    entrypoints: [
      '@pellux/goodvibes-sdk/platform',
      '@pellux/goodvibes-sdk/platform/index',
      '@pellux/goodvibes-sdk/platform/providers',
      '@pellux/goodvibes-sdk/platform/voice',
      '@pellux/goodvibes-sdk/platform/multimodal',
      '@pellux/goodvibes-sdk/platform/node',
      '@pellux/goodvibes-sdk/platform/node/index',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'provider-sdk'],
    dependencyFamilies: [
      'openai',
      '@anthropic-ai/sdk',
      '@anthropic-ai/bedrock-sdk',
      'google-auth-library',
      'node-edge-tts',
    ],
  },
  {
    id: 'local-tools',
    description: 'Filesystem, shell, git, AST, language-server, and workflow tools used by daemon/TUI runtimes.',
    entrypoints: [
      '@pellux/goodvibes-sdk/platform',
      '@pellux/goodvibes-sdk/platform/index',
      '@pellux/goodvibes-sdk/platform/tools',
      '@pellux/goodvibes-sdk/platform/intelligence',
      '@pellux/goodvibes-sdk/platform/git',
      '@pellux/goodvibes-sdk/platform/node',
      '@pellux/goodvibes-sdk/platform/node/index',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'child-process', 'native-module'],
    dependencyFamilies: [
      '@ast-grep/napi',
      'simple-git',
      'web-tree-sitter',
      'tree-sitter-*',
      'bash-language-server',
      'pyright',
      'typescript-language-server',
      'vscode-langservers-extracted',
    ],
  },
] as const;

export function isClientSafeGoodVibesEntrypoint(entrypoint: string): boolean {
  return (GOODVIBES_CLIENT_SAFE_ENTRYPOINTS as readonly string[]).includes(entrypoint);
}

export function isNodeRuntimeGoodVibesEntrypoint(entrypoint: string): boolean {
  return (GOODVIBES_NODE_RUNTIME_ENTRYPOINTS as readonly string[]).includes(entrypoint);
}

export function listGoodVibesRuntimeCapabilities(
  surface?: GoodVibesRuntimeSurface,
): readonly GoodVibesRuntimeCapability[] {
  if (!surface) return GOODVIBES_RUNTIME_CAPABILITIES;
  return GOODVIBES_RUNTIME_CAPABILITIES.filter((capability) => (
    capability.surfaces.includes(surface)
  ));
}
