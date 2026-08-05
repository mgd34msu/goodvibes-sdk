/**
 * setup-chain.ts — VOICE as an instance of the platform's setup contract.
 *
 * The rules this follows are not voice's: they live in
 * runtime/setup-contract.ts, which states them for any service — DO the literal
 * ask and everything the environment already answers, PROPOSE each inferred
 * extension as one short approval question, ASK only at genuine forks, pick a
 * solution shape rather than reasoning case by case, and never hand the user a
 * command to type.
 *
 * What is voice-specific is only the domain knowledge: that a wake word with no
 * speech-to-text hears its name and can do nothing with the sentence after it
 * (so STT is the inferred extension), that an empty input device means the
 * operating system default (so it is stated, never asked), and that local
 * versus a hosted voice account is a real trade the user owns (so it is the
 * fork). Another service fills in its own equivalents against the same shape.
 */
import type { WakeSurface } from './wake/settings.js';
import {
  mentionsUserTypedCommand,
  renderSetupPlan,
  setupPlanStrings,
  setupStepsOfKind,
  type SetupOption,
  type SetupPlan,
  type SetupStep,
} from '../runtime/setup-contract.js';

/** What the user asked for, as far as the entry point could tell. */
export type VoiceSetupIntent = 'wake' | 'stt' | 'tts' | 'voice';

/** One step in a resolved setup chain — the platform's general step shape. */
export type VoiceSetupStep = SetupStep;

/** One side of a genuine fork. */
export type VoiceSetupOption = SetupOption;

/** Everything known about the host when the request arrived. */
export interface VoiceSetupContext {
  /** The surface the request came from — the one that must end up listening. */
  readonly surface: WakeSurface;
  /** `voice.wake.enabled`. */
  readonly wakeEnabled: boolean;
  /** `voice.wake.surfaces.<surface>`. */
  readonly surfaceEnabled: boolean;
  /** Wake models present and verified on disk. */
  readonly wakeProvisioned: boolean;
  /** Managed speech-to-text present and pointed at by config. */
  readonly sttReady: boolean;
  /** Managed text-to-speech present and pointed at by config. */
  readonly ttsReady: boolean;
  /** `voice.wake.inputDevice`; empty means the operating system default source. */
  readonly inputDevice: string;
  /**
   * A cloud voice credential this host already holds (ElevenLabs, OpenAI...).
   * Present means the local-vs-hosted fork is real; absent means local is the
   * only path that needs no new secret, so it is chosen rather than asked.
   */
  readonly cloudVoiceProviders?: readonly string[] | undefined;
}

/** A resolved chain: what was done, what is proposed, what must be asked. */
export type VoiceSetupChain = SetupPlan;

/** The steps of one kind, in order. */
export function voiceSetupStepsOfKind(chain: VoiceSetupChain, kind: VoiceSetupStep['kind']): readonly VoiceSetupStep[] {
  return setupStepsOfKind(chain, kind);
}

/**
 * Resolve a setup request into the chain the platform owes.
 *
 * Pure: it decides what to do, propose and ask. Performing the `done` steps is
 * the caller's job, because only the caller holds the installer and the config
 * writer.
 */
export function planVoiceSetupChain(intent: VoiceSetupIntent, context: VoiceSetupContext): VoiceSetupChain {
  const steps: VoiceSetupStep[] = [];
  const wantsWake = intent === 'wake' || intent === 'voice';
  // A wake word IMPLIES speech-to-text. This is the inference the whole module
  // exists for: asking for a wake word and getting one that hears its name and
  // can do nothing with the sentence after it is answering the ask and missing
  // the goal. It arrives as a PROPOSAL below, never as a silent install.
  const wantsStt = intent === 'stt' || intent === 'voice' || wantsWake;
  const wantsTts = intent === 'tts' || intent === 'voice';

  if (wantsWake) {
    // The literal ask: the surface that asked is the surface that listens. The
    // two-flag pair moves together — a master switch on a surface that is
    // opted out is a setting that configures nothing.
    steps.push({
      kind: 'do',
      subject: 'wake',
      message: context.wakeEnabled && context.surfaceEnabled
        ? `Wake-word detection was already on for the ${context.surface} surface.`
        : `Wake-word detection is on, and the ${context.surface} surface is listening for it `
          + '(both the feature and this surface\'s row were needed, so both were set).',
    });
    if (!context.wakeProvisioned) {
      steps.push({
        kind: 'do',
        subject: 'wake-models',
        message: 'The wake models were missing, so they were downloaded and checksum-verified as part of this.',
      });
    }
    // The environment already answers this, so it is stated, never asked.
    steps.push({
      kind: 'do',
      subject: 'input-device',
      message: context.inputDevice.trim().length === 0
        ? 'Listening on your system default input, so it follows whatever the operating system is using — including a headset that comes and goes.'
        : `Listening on the input device you have pinned (${context.inputDevice}). If that device is away, wake stops hearing you until it is back.`,
    });
  }

  if (wantsStt && !context.sttReady) {
    if (wantsWake) {
      // The inference: a wake word with no speech-to-text hears its name and
      // can do nothing with the sentence after it. Proposed, not assumed.
      steps.push({
        kind: 'propose',
        subject: 'stt',
        message: 'A wake word is only useful if what you say next becomes text, and speech-to-text is not set up on this machine yet — '
          + 'shall I provision the local speech-to-text runtime now so the whole thing works end to end?',
      });
    } else {
      steps.push({
        kind: 'do',
        subject: 'stt',
        message: 'The local speech-to-text runtime is installed and pointed at.',
      });
    }
  } else if (wantsStt) {
    steps.push({ kind: 'do', subject: 'stt', message: 'Speech-to-text was already working on this machine.' });
  }

  if (wantsTts && !context.ttsReady) {
    const cloud = context.cloudVoiceProviders ?? [];
    if (cloud.length > 0) {
      // A genuine fork: both paths work, and the choice is a real trade the
      // user owns. One line each, so the answer is a word.
      steps.push({
        kind: 'ask',
        subject: 'tts-provider',
        message: 'For the voice that speaks back, which would you prefer?',
        options: [
          {
            id: 'local',
            label: 'The local engine',
            trade: 'Runs offline on this machine and costs nothing, and sounds like a good free voice rather than a great paid one.',
          },
          ...cloud.map((provider) => ({
            id: provider,
            label: `Your ${provider} account`,
            trade: `Noticeably better voices, billed to the ${provider} credential this machine already holds, and it needs the network.`,
          })),
        ],
      });
    } else {
      // No credential on the host: local is the only path that needs no new
      // secret, so it is taken rather than turned into a question.
      steps.push({
        kind: 'do',
        subject: 'tts',
        message: 'The local text-to-speech engine is installed and pointed at, so speech works offline with nothing further to sign up for.',
      });
    }
  } else if (wantsTts) {
    steps.push({ kind: 'do', subject: 'tts', message: 'Text-to-speech was already working on this machine.' });
  }

  return { intent, shapes: ['guided-walkthrough'], steps };
}

/**
 * Does this text tell the user to type a command?
 *
 * The shapes that matter: a slash command presented as the user's next action,
 * and the imperative verbs that introduce one. Used by the test that keeps
 * setup replies free of them — the platform does the thing, then says what it
 * did.
 */
export function voiceSetupStepMentionsUserCommand(text: string): boolean {
  return mentionsUserTypedCommand(text);
}

/** Every user-facing string in a chain, for assertions and rendering. */
export function voiceSetupChainStrings(chain: VoiceSetupChain): readonly string[] {
  return setupPlanStrings(chain);
}

/** Render the chain as the reply a surface prints. */
export function renderVoiceSetupChain(chain: VoiceSetupChain): string {
  return renderSetupPlan(chain);
}
