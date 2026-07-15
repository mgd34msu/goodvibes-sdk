/**
 * routes/voice-setup.ts — handlers for the managed local-voice provisioning
 * verbs over the live provisioner + config (see voice/provisioning/*).
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
  readonly stt: { readonly engine: string; readonly state: string; readonly reason: string };
  readonly components: ReadonlyArray<{ readonly id: string; readonly state: string; readonly bytes?: number | undefined; readonly error?: string | undefined }>;
  readonly configured: {
    readonly set: ReadonlyArray<{ readonly key: string; readonly value: string }>;
    readonly skipped: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
  };
}

/** The narrow provisioning slice the verbs need. */
export interface VoiceSetupGatewayService {
  status(): unknown;
  install(): Promise<VoiceLocalInstallResult>;
}

export function createVoiceStatusHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.status();
}

export function createVoiceInstallHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.install();
}

/** Attach the voice-setup handlers to their registered descriptors (missing = no-op). */
export function registerVoiceSetupGatewayMethods(catalog: GatewayMethodCatalog, service: VoiceSetupGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('voice.local.status', createVoiceStatusHandler(service));
  attach('voice.local.install', createVoiceInstallHandler(service));
}
