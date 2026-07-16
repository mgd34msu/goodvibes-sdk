/**
 * install-progress.ts — live per-component progress for the ACTIVE
 * voice.local.install run.
 *
 * The install verb is plain request/response, so during a ~209MB provision a
 * surface would otherwise only render busy→receipt. This tracker turns the
 * provisioner's existing onProgress stream into a poll-able snapshot: the
 * daemon composition begins/ends it around the single-flight install (a second
 * concurrent install caller already joins the in-flight run), and
 * voice.local.status carries the snapshot as `installInProgress` while — and
 * only while — an install is active. Surfaces poll status during install; no
 * streaming infrastructure involved.
 */
import type { ProvisionPhase, VoiceProvisionProgress } from './provisioner.js';

/** The latest observed state of one install component (latest phase wins). */
export interface VoiceInstallComponentProgress {
  readonly component: string;
  readonly phase: ProvisionPhase;
  readonly message?: string | undefined;
  /** The component's pinned size in bytes, where the manifest knows it. */
  readonly bytesTotal?: number | undefined;
  /** Bytes landed on disk, where known (completion boundaries — downloads verify whole-file). */
  readonly bytesDone?: number | undefined;
}

/** What voice.local.status serves under `installInProgress` while an install runs. */
export interface VoiceInstallProgressSnapshot {
  /** Epoch ms the active install began. */
  readonly startedAt: number;
  /** Per-component progress in first-seen order. */
  readonly components: readonly VoiceInstallComponentProgress[];
}

export interface VoiceInstallProgressTracker {
  /** Mark an install active (clears any previous run's components). */
  begin(): void;
  /** Mark the install finished — snapshot() returns null again. */
  end(): void;
  /** Wire this as (or from) the provisioner's onProgress. */
  onProgress(progress: VoiceProvisionProgress): void;
  /** The active install's progress, or null when no install is running. */
  snapshot(): VoiceInstallProgressSnapshot | null;
}

/**
 * Composition-scoped tracker: one per daemon (matching the single-flight
 * install guard — concurrent installs never run in parallel).
 */
export function createVoiceInstallProgressTracker(now: () => number = Date.now): VoiceInstallProgressTracker {
  let active: { startedAt: number; components: Map<string, VoiceInstallComponentProgress> } | null = null;
  return {
    begin(): void {
      active = { startedAt: now(), components: new Map() };
    },
    end(): void {
      active = null;
    },
    onProgress(progress: VoiceProvisionProgress): void {
      if (!active) return; // progress outside an active window is dropped, never resurrected
      const previous = active.components.get(progress.component);
      // Latest phase/message win; byte fields persist from earlier events when
      // a later event omits them (e.g. an extract event after a byte-labeled
      // download) so the snapshot never loses the known totals.
      active.components.set(progress.component, {
        component: progress.component,
        phase: progress.phase,
        ...(progress.message !== undefined ? { message: progress.message } : {}),
        ...(progress.bytesTotal !== undefined
          ? { bytesTotal: progress.bytesTotal }
          : previous?.bytesTotal !== undefined ? { bytesTotal: previous.bytesTotal } : {}),
        ...(progress.bytesDone !== undefined
          ? { bytesDone: progress.bytesDone }
          : previous?.bytesDone !== undefined ? { bytesDone: previous.bytesDone } : {}),
      });
    },
    snapshot(): VoiceInstallProgressSnapshot | null {
      if (!active) return null;
      return { startedAt: active.startedAt, components: [...active.components.values()] };
    },
  };
}
