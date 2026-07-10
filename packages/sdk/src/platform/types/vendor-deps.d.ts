/**
 * Minimal ambient type declarations for vendor dependencies that ship without
 * bundled type declarations.
 *
 * Each module here is an actual SDK dependency (not a peer dep) that lacks
 * a `@types/` package or built-in `.d.ts` files. The declarations are kept
 * intentionally minimal — only the shapes actually consumed by SDK code.
 *
 * TS7016 root cause: these modules use CommonJS or untyped dist/ bundles
 * that TypeScript cannot introspect under `noImplicitAny`. Adding ambient
 * declarations here satisfy the checker without requiring `skipLibCheck: true`
 * overrides or per-file `@ts-ignore` suppressions.
 */

// @agentclientprotocol/sdk — ACP client/agent protocol library.
declare module '@agentclientprotocol/sdk' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Client = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Agent = any;
  // AgentSideConnection is used as a constructor by the agent-side adapter
  // (new AgentSideConnection(toAgent, stream)), so it must be a value (class).
  // The two client-callback methods the adapter invokes are declared with
  // real minimal shapes so the protocol mapping stays type-checked.
  export class AgentSideConnection {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(toAgent: (conn: AgentSideConnection) => Agent, stream: any);
    sessionUpdate(params: SessionNotification): Promise<void>;
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  }
  // ClientSideConnection is used as a constructor (new ClientSideConnection(...)),
  // so it must be a value (class), not just a type alias.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class ClientSideConnection {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type RequestError = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SessionNotification = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PromptRequest = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PromptResponse = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type InitializeRequest = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type InitializeResponse = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type NewSessionRequest = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type NewSessionResponse = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type RequestPermissionRequest = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type RequestPermissionResponse = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ndJsonStream: any;

  // ── Agent-side protocol shapes (consumed by platform/acp/agent.ts) ──────────
  // Minimal but REAL types (not `any`) for the symbols the agent adapter maps
  // against, mirroring @agentclientprotocol/sdk 0.21.0's generated schema.
  export const PROTOCOL_VERSION: number;
  export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'audio'; data: string; mimeType: string }
    | { type: 'resource_link'; uri: string; name: string }
    | { type: 'resource'; resource: Record<string, unknown> };
  export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  export interface PermissionOption {
    optionId: string;
    name: string;
    kind: PermissionOptionKind;
  }
  export interface AuthenticateRequest {
    methodId: string;
  }
  export type AuthenticateResponse = Record<string, unknown> | null;
  export interface CancelNotification {
    sessionId: string;
  }
}

// Fuse.js — fuzzy-search library (used by registry-tool / knowledge search).
declare module 'fuse.js' {
  export interface IFuseOptions<T> {
    keys?: Array<string | { name: string; weight: number }>;
    threshold?: number;
    includeScore?: boolean;
    minMatchCharLength?: number;
    [key: string]: unknown;
  }
  export interface FuseResult<T> {
    item: T;
    score?: number;
    refIndex: number;
  }
  export default class Fuse<T> {
    constructor(list: readonly T[], options?: IFuseOptions<T>);
    search(pattern: string): FuseResult<T>[];
    setCollection(list: readonly T[]): void;
  }
}

// node-edge-tts — Microsoft Edge TTS voice provider.
declare module 'node-edge-tts' {
  export interface EdgeTTSOptions {
    voice?: string;
    lang?: string;
    outputFormat?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
  }
  export class EdgeTTS {
    constructor(options?: EdgeTTSOptions);
    ttsPromise(text: string, saveFile: string): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export default EdgeTTS;
}

// node-edge-tts sub-path entry used by the voice provider.
declare module 'node-edge-tts/dist/drm.js' {
  export const CHROMIUM_FULL_VERSION: string;
  export const TRUSTED_CLIENT_TOKEN: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function generateSecMsGecToken(clientToken?: string, version?: string): string;
}

// simple-git — Git wrapper used by the git integration service.
declare module 'simple-git' {
  export interface SimpleGitOptions {
    baseDir?: string;
    binary?: string;
    maxConcurrentProcesses?: number;
    trimmed?: boolean;
  }
  export interface FileStatusResult {
    path: string;
    index: string;
    working_dir: string;
  }
  export interface StatusResult {
    not_added: string[];
    conflicted: string[];
    created: string[];
    deleted: string[];
    modified: string[];
    renamed: Array<{ from: string; to: string }>;
    staged: string[];
    files: FileStatusResult[];
    ahead: number;
    behind: number;
    current: string | null;
    tracking: string | null;
    detached: boolean;
    isClean(): boolean;
  }
  export interface CommitResult {
    commit: string;
    summary: Record<string, unknown>;
  }
  export interface SimpleGit {
    status(): Promise<StatusResult>;
    commit(
      message: string,
      files: undefined,
      options: string[],
    ): Promise<CommitResult>;
    log(options?: Record<string, unknown>): Promise<{
      all: ReadonlyArray<{
        hash: string;
        date: string;
        message: string;
        author_name: string;
        author_email: string;
        refs: string;
        body: string;
      }>;
      latest: {
        hash: string;
        date: string;
        message: string;
        author_name: string;
        author_email: string;
      } | null;
      total: number;
    }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
  function simpleGit(options?: string | Partial<SimpleGitOptions>): SimpleGit;
  export default simpleGit;
  export { simpleGit };
}
