export type SandboxEvalIsolationMode = 'shared-vm' | 'per-runtime-vm';
export type SandboxMcpIsolationMode = 'disabled' | 'shared-vm' | 'hybrid' | 'per-server-vm';
export type SandboxWindowsMode = 'native-basic' | 'require-wsl';
export type SandboxVmBackend = 'local' | 'qemu';
export type SandboxResolvedBackend = 'local' | 'qemu';
export type SandboxQemuSessionMode = 'attach' | 'launch-per-command';

export interface SandboxConfigSnapshot {
  readonly replIsolation: SandboxEvalIsolationMode;
  readonly mcpIsolation: SandboxMcpIsolationMode;
  readonly windowsMode: SandboxWindowsMode;
  readonly vmBackend: SandboxVmBackend;
  readonly qemuBinary: string;
  readonly qemuImagePath: string;
  readonly qemuExecWrapper: string;
  readonly qemuGuestHost: string;
  readonly qemuGuestPort: number;
  readonly qemuGuestUser: string;
  readonly qemuWorkspacePath: string;
  readonly qemuSessionMode: SandboxQemuSessionMode;
}

export interface SandboxHostStatus {
  readonly platform: NodeJS.Platform;
  readonly runningInWsl: boolean;
  readonly windows: boolean;
  readonly secureSandboxReady: boolean;
  readonly recommendedBackend: SandboxVmBackend;
  readonly warnings: readonly string[];
}

export interface SandboxProfile {
  readonly id:
    | 'eval-js'
    | 'eval-ts'
    | 'eval-py'
    | 'eval-sql'
    | 'eval-graphql'
    | 'mcp-shared'
    | 'mcp-per-server';
  readonly label: string;
  readonly kind: 'eval' | 'mcp';
  readonly isolation: 'shared' | 'dedicated';
  readonly requiresVm: boolean;
  readonly notes: readonly string[];
}

export interface SandboxPreset {
  readonly id: 'secure-balanced' | 'secure-isolated' | 'shared-performance' | 'windows-basic';
  readonly label: string;
  readonly summary: string;
  readonly config: SandboxConfigSnapshot;
  readonly notes: readonly string[];
}

export interface SandboxReview {
  readonly config: SandboxConfigSnapshot;
  readonly host: SandboxHostStatus;
  readonly profiles: readonly SandboxProfile[];
  readonly backendProbe?: SandboxBackendProbe | undefined;
}

export interface SandboxProbe {
  readonly version: 1;
  readonly checkedAt: number;
  readonly host: string;
  readonly currentBackend: string;
  readonly replIsolation: string;
  readonly mcpIsolation: string;
  readonly windowsMode: string;
  readonly secureSandboxReady: boolean;
  readonly recommendedCommand: string;
}

export interface SandboxBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly review: {
    readonly reviewText: string;
    readonly recommendationText: string;
    readonly profilesText: string;
  };
}

export type SandboxSessionKind = 'eval' | 'mcp';
export type SandboxSessionState = 'running' | 'stopped' | 'planned' | 'failed';

export interface SandboxBackendAvailability {
  readonly id: SandboxResolvedBackend;
  readonly available: boolean;
  readonly detail: string;
}

export interface SandboxBackendProbe {
  readonly requestedBackend: SandboxVmBackend;
  readonly resolvedBackend: SandboxResolvedBackend;
  readonly backends: readonly SandboxBackendAvailability[];
  readonly warnings: readonly string[];
}

export interface SandboxLaunchPlan {
  readonly backend: SandboxResolvedBackend;
  readonly command: string;
  readonly args: readonly string[];
  readonly workspaceRoot: string;
  readonly summary: string;
  readonly imagePath?: string | undefined;
}

export interface SandboxSession {
  readonly id: string;
  readonly profileId: SandboxProfile['id'];
  readonly kind: SandboxSessionKind;
  readonly label: string;
  readonly shared: boolean;
  readonly startedAt: number;
  readonly state: SandboxSessionState;
  readonly backend: SandboxVmBackend;
  readonly resolvedBackend?: SandboxResolvedBackend | undefined;
  readonly launchPlan?: SandboxLaunchPlan | undefined;
  readonly startupStatus?: 'verified' | 'planned' | 'failed' | undefined;
  readonly startupDetail?: string | undefined;
  readonly managedGuestPid?: number | undefined;
  readonly managedGuestHost?: string | undefined;
  readonly managedGuestPort?: number | undefined;
  readonly lastRunAt?: number | undefined;
  readonly lastCommandSummary?: string | undefined;
  readonly lastExitStatus?: number | null | undefined;
  readonly lastStdoutPreview?: string | undefined;
  readonly lastStderrPreview?: string | undefined;
  readonly executionCount?: number | undefined;
  readonly notes: readonly string[];
}

export interface SandboxSessionArtifact {
  readonly version: 1;
  readonly exportedAt: number;
  readonly session: SandboxSession;
  readonly reviewText: string;
}

export interface ProfileBundleEntry {
  readonly name: string;
  readonly timestamp: number;
  readonly data: import('../../profiles/manager.js').ProfileData;
}

export interface ProfileSyncBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly activeProfile?: string | undefined;
  readonly profiles: readonly ProfileBundleEntry[];
}

export interface ManagedSettingsBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly profileName: string;
  readonly settings: Record<string, unknown>;
}
