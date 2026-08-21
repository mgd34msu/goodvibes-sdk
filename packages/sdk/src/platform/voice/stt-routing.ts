/**
 * stt-routing.ts, which runtime turns captured audio into words.
 *
 * DAEMON-FIRST, AND THE USER DOES NOT CARE WHICH PROCESS OWNS WHISPER.
 *
 * The agent used to transcribe through its OWN in-process voice service and
 * nothing else. On a machine whose config reads were broken, that service's
 * local provider threw 'local STT is not configured', while the daemon's
 * `voice.stt` was live and working, in the same session, on the same host, with
 * the same managed whisper install behind it. Two processes on one machine
 * disagreed about whether speech-to-text existed, and the user was told it did
 * not.
 *
 * So the route is resolved rather than assumed: when this process holds a
 * connection to a host, the audio goes to the HOST, which is the runtime that
 * owns the managed install and is reachable from every surface. The in-process
 * provider is the fallback, used when there is no connected host or the host
 * could not answer, and when it is used, the reason the first choice was not
 * is stated rather than hidden.
 *
 * Every attempt is recorded as a diagnostic (see diagnostics.ts): the provider,
 * where its configuration came from, and the verbatim exception. A failure that
 * only ever reached a notification banner is a failure nobody can explain later.
 */
import type { VoiceDiagnosticEntry, VoiceDiagnosticRoute } from './diagnostics.js';

/** The audio shape a capture path produces, as far as routing cares. */
export interface SttAudioInput {
  readonly mimeType: string;
  readonly format: string;
  readonly dataBase64?: string | undefined;
  readonly sampleRateHz?: number | undefined;
  readonly durationMs?: number | undefined;
}

/** One transcription path, with enough about it to explain what it did. */
export interface SttRouteCandidate {
  readonly route: Exclude<VoiceDiagnosticRoute, 'none'>;
  /** The provider this route will use, as far as the caller knows it. */
  readonly provider: string;
  /** Where the configuration behind it came from. */
  readonly configSource: string;
  transcribe(audio: SttAudioInput): Promise<string>;
}

export interface SttRoutingDeps {
  /**
   * Ship the audio to the connected host's `voice.stt`. Absent when this
   * process holds no host connection, which is the honest reason to use the
   * in-process provider, rather than a preference.
   */
  readonly connectedHost?: SttRouteCandidate | null | undefined;
  /** This process's own voice service. Absent when no STT provider is registered. */
  readonly inProcess?: SttRouteCandidate | null | undefined;
  /** Why there is no in-process provider, for the reply when neither route exists. */
  readonly inProcessAbsence?: string | undefined;
  /** Record one attempt. Never throws; see diagnostics.ts. */
  readonly recordDiagnostic?: ((entry: VoiceDiagnosticEntry) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

/** What a transcription attempt did, including the route it ended up on. */
export interface SttTranscription {
  readonly text: string;
  readonly route: Exclude<VoiceDiagnosticRoute, 'none'>;
  /** Plain words for a surface: which runtime transcribed, and why that one. */
  readonly explanation: string;
}

/** Thrown when every available route failed, carrying what each one said. */
export class SttRoutesExhaustedError extends Error {
  readonly code = 'STT_ROUTES_EXHAUSTED';
  /** One line per attempted route, in order. */
  readonly attempts: readonly string[];
  constructor(attempts: readonly string[]) {
    super(
      attempts.length === 0
        ? 'Speech-to-text has no route on this host: no connected host to send the audio to, and no local provider registered in this process.'
        : `Speech-to-text failed on every available route. ${attempts.join(' ')}`,
    );
    this.name = 'SttRoutesExhaustedError';
    this.attempts = attempts;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Transcribe through the best available route, falling back with a stated
 * reason. The connected host is tried first whenever one exists.
 */
export async function transcribeThroughBestRoute(
  audio: SttAudioInput,
  deps: SttRoutingDeps,
): Promise<SttTranscription> {
  const now = deps.now ?? (() => new Date());
  const record = (entry: VoiceDiagnosticEntry): void => { deps.recordDiagnostic?.(entry); };
  const candidates = [deps.connectedHost, deps.inProcess].filter((candidate): candidate is SttRouteCandidate => !!candidate);

  if (candidates.length === 0) {
    record({
      at: now().toISOString(),
      operation: 'stt',
      route: 'none',
      ok: false,
      provider: 'none',
      configSource: 'none',
      error: deps.inProcessAbsence ?? 'no speech-to-text route exists in this process',
    });
    throw new SttRoutesExhaustedError([]);
  }

  const attempts: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const text = await candidate.transcribe(audio);
      record({
        at: now().toISOString(),
        operation: 'stt',
        route: candidate.route,
        ok: true,
        provider: candidate.provider,
        configSource: candidate.configSource,
        ...(attempts.length > 0 ? { detail: `after ${attempts.length} route(s) failed: ${attempts.join(' ')}` } : {}),
      });
      return {
        text,
        route: candidate.route,
        explanation: index === 0
          ? describeRoute(candidate)
          // The fallback names what it fell back FROM. A silent downgrade is how
          // a host ends up transcribing with a provider nobody chose.
          : `${describeRoute(candidate)} (the connected host was tried first and could not: ${attempts.join(' ')})`,
      };
    } catch (error) {
      const detail = describeError(error);
      attempts.push(`${candidate.route} (${candidate.provider}): ${detail}`);
      record({
        at: now().toISOString(),
        operation: 'stt',
        route: candidate.route,
        ok: false,
        provider: candidate.provider,
        configSource: candidate.configSource,
        error: detail,
      });
    }
  }
  throw new SttRoutesExhaustedError(attempts);
}

/** Plain words for which runtime transcribed and where its config came from. */
export function describeRoute(candidate: SttRouteCandidate): string {
  return candidate.route === 'connected-host'
    ? `transcribed by the connected host using ${candidate.provider} (configured from ${candidate.configSource})`
    : `transcribed in this process using ${candidate.provider} (configured from ${candidate.configSource})`;
}
