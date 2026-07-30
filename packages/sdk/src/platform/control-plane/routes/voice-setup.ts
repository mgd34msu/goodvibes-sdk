/**
 * routes/voice-setup.ts — handlers for the managed local-voice provisioning
 * verbs over the live provisioner + config (see voice/provisioning/*), and for
 * the wake-word artifacts served alongside them.
 *
 * The wake verbs attach HERE rather than through a group of their own for a
 * composition reason worth stating: this group is already wired into the gateway,
 * so the same service object gains three methods and the registration site does
 * not change. A new group would have meant editing the verb-group composition
 * file for a capability that is provisioning a pinned voice artifact — which is
 * exactly what this module already is.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';

/** One-act install outcome served by voice.local.install. */
export interface VoiceLocalInstallResult {
  readonly provisioned: boolean;
  readonly platform: string | null;
  readonly tts: {
    readonly engine: string;
    readonly state: string;
    readonly binaryPath?: string | undefined;
    readonly modelPath?: string | undefined;
    readonly reason?: string | undefined;
  };
  readonly stt: { readonly engine: string; readonly state: string; readonly binaryPath?: string | undefined; readonly modelPath?: string | undefined; readonly reason?: string | undefined };
  readonly components: ReadonlyArray<{ readonly id: string; readonly state: string; readonly bytes?: number | undefined; readonly error?: string | undefined }>;
  readonly configured: {
    readonly set: ReadonlyArray<{ readonly key: string; readonly value: string }>;
    readonly skipped: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
  };
}

/** One bounded chunk of a provisioned wake artifact. */
export interface WakeModelChunkPayload {
  readonly component: string;
  readonly offset: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly dataBase64: string;
  readonly complete: boolean;
}

/** The narrow provisioning slice the verbs need. */
export interface VoiceSetupGatewayService {
  status(): unknown;
  install(): Promise<VoiceLocalInstallResult>;
  /** Content-verified state of the pinned wake artifacts. */
  wakeStatus(): unknown;
  /** Download + verify the pinned wake artifacts. Explicit act, single-flight. */
  wakeProvision(): Promise<unknown>;
  /** Read one wake artifact in bounded chunks, for a surface that cannot fetch it. */
  wakeModelChunk(request: { component: string; offset?: number | undefined; maxBytes?: number | undefined }): WakeModelChunkPayload;
}

export function createVoiceStatusHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.status();
}

export function createVoiceInstallHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.install();
}

export function createWakeStatusHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.wakeStatus();
}

export function createWakeProvisionHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.wakeProvision();
}

/**
 * Read one chunk. The component is validated here rather than trusted: an
 * unrecognised name is a caller error with a written message, not a path built
 * out of whatever arrived.
 */
export function createWakeModelHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return (input) => {
    const params = (input ?? {}) as { component?: unknown; offset?: unknown; maxBytes?: unknown };
    const component = typeof params.component === 'string' ? params.component : '';
    if (component !== 'classifier' && component !== 'embedding' && component !== 'notice') {
      throw new Error(`voice.wake.model.get: component must be classifier, embedding or notice (got "${component}")`);
    }
    return service.wakeModelChunk({
      component,
      offset: typeof params.offset === 'number' ? params.offset : undefined,
      maxBytes: typeof params.maxBytes === 'number' ? params.maxBytes : undefined,
    });
  };
}

/** Attach the voice-setup handlers to their registered descriptors (missing = no-op). */
export function registerVoiceSetupGatewayMethods(catalog: GatewayMethodCatalog, service: VoiceSetupGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('voice.local.status', createVoiceStatusHandler(service));
  attach('voice.local.install', createVoiceInstallHandler(service));
  attach('voice.wake.status', createWakeStatusHandler(service));
  attach('voice.wake.provision', createWakeProvisionHandler(service));
  attach('voice.wake.model.get', createWakeModelHandler(service));
}
