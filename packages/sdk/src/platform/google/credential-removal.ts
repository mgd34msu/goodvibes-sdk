/**
 * Removing or replacing a stored Google credential — which never happens
 * without the owner saying yes first.
 *
 * The defect this exists to fix: mid-flow, with nothing asked and nothing
 * announced, the stored refresh token was deleted. The owner found out because
 * the connection stopped working. A refresh token is not a cache entry — it is
 * the thing that took a person through a consent screen to obtain, and on a
 * published app it is the only durable half of the credential. Deleting one
 * unprompted destroys work the machine cannot recreate on its own.
 *
 * So this module makes the destructive step impossible to reach by accident.
 * There is no function here that deletes on the first call. `planRemoval`
 * returns a sentence naming exactly what would go; only a second call carrying
 * an explicit yes actually removes anything, and the result states what was
 * removed rather than reporting a bare success.
 *
 * The same gate covers REPLACEMENT, because overwriting a refresh token with a
 * different one destroys the old one just as thoroughly as deleting it.
 */

import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';

/**
 * Secret storage that can also remove. Deliberately separate from
 * `GoogleSecretPort`: a store with no delete simply cannot perform a removal,
 * and that must be a typed refusal rather than a silent no-op.
 */
export interface GoogleRemovableSecretPort extends GoogleSecretPort {
  delete(key: string): Promise<void>;
}

/** Which stored things a removal would touch. */
export type GoogleCredentialItem = 'refresh-token' | 'client-secret' | 'app-password' | 'calendar-address';

/** Safe-to-display name for each item. Never a value. */
const ITEM_LABELS: Readonly<Record<GoogleCredentialItem, string>> = {
  'refresh-token': 'the Google refresh token (the credential your consent produced)',
  'client-secret': 'the OAuth client secret',
  'app-password': 'the Gmail app password',
  'calendar-address': 'the private calendar address',
};

const ITEM_SECRET_KEYS: Readonly<Record<GoogleCredentialItem, string>> = {
  'refresh-token': GOOGLE_SECRET_KEYS.oauthRefreshToken,
  'client-secret': GOOGLE_SECRET_KEYS.oauthClientSecret,
  'app-password': GOOGLE_SECRET_KEYS.appPassword,
  'calendar-address': GOOGLE_SECRET_KEYS.calendarIcsUrl,
};

/** Nothing has been removed. This is the only thing a first call can return. */
export interface GoogleRemovalPlan {
  readonly confirmed: false;
  readonly removed: readonly [];
  /** The items that WOULD be removed, by safe label. */
  readonly wouldRemove: readonly string[];
  /** One sentence, ending in a question. Show this and wait for a yes. */
  readonly prompt: string;
}

/** Something was actually removed, and this says exactly what. */
export interface GoogleRemovalDone {
  readonly confirmed: true;
  readonly removed: readonly string[];
  readonly wouldRemove: readonly [];
  readonly detail: string;
}

/** The removal could not run at all. Nothing was touched. */
export interface GoogleRemovalRefused {
  readonly confirmed: false;
  readonly removed: readonly [];
  readonly wouldRemove: readonly [];
  readonly prompt: string;
  readonly refused: true;
}

export type GoogleRemovalResult = GoogleRemovalPlan | GoogleRemovalDone | GoogleRemovalRefused;

export interface GoogleRemovalRequest {
  readonly items: readonly GoogleCredentialItem[];
  /**
   * The owner's explicit yes, for this exact removal.
   *
   * Defaults to false and there is no way to default it to true. A caller that
   * wants a removal to happen has to pass this deliberately, which means the
   * decision is always written down at the call site.
   */
  readonly confirmed?: boolean;
  /** Why the removal was proposed, quoted back in the prompt. */
  readonly reason?: string;
}

export interface GoogleRemovalDeps {
  readonly secrets: GoogleSecretPort;
  readonly config: GoogleConfigPort;
}

function isRemovable(secrets: GoogleSecretPort): secrets is GoogleRemovableSecretPort {
  return typeof (secrets as Partial<GoogleRemovableSecretPort>).delete === 'function';
}

/** True when a secret exists and is non-empty. Never returns the value. */
async function secretPresent(secrets: GoogleSecretPort, key: string): Promise<boolean> {
  try {
    const value = await secrets.get(key);
    return typeof value === 'string' && value.trim().length > 0;
  } catch {
    return false;
  }
}

function buildPrompt(labels: readonly string[], reason: string | undefined): string {
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const because = reason === undefined || reason.trim().length === 0 ? '' : ` ${reason.trim()}`;
  return (
    `This would permanently remove ${list} from the encrypted store, and re-approving a consent screen is the only way to get it back.${because}`
    + ' Do you want me to remove it?'
  );
}

/**
 * Remove stored Google credentials — but only with an explicit yes.
 *
 * Called without `confirmed`, this changes nothing and hands back the sentence
 * to put in front of the owner. Called with `confirmed: true`, it removes the
 * items that are actually present and reports each one by name.
 */
export async function removeGoogleCredentials(
  deps: GoogleRemovalDeps,
  request: GoogleRemovalRequest,
): Promise<GoogleRemovalResult> {
  const present: GoogleCredentialItem[] = [];
  for (const item of request.items) {
    if (await secretPresent(deps.secrets, ITEM_SECRET_KEYS[item])) present.push(item);
  }

  if (present.length === 0) {
    return {
      confirmed: true,
      removed: [],
      wouldRemove: [],
      detail: 'Nothing was removed — none of those credentials are stored on this machine.',
    };
  }

  const labels = present.map((item) => ITEM_LABELS[item]);

  if (request.confirmed !== true) {
    return {
      confirmed: false,
      removed: [],
      wouldRemove: labels,
      prompt: buildPrompt(labels, request.reason),
    };
  }

  if (!isRemovable(deps.secrets)) {
    return {
      confirmed: false,
      removed: [],
      wouldRemove: [],
      refused: true,
      prompt: 'This secret store cannot remove values, so nothing was changed. Remove the credential with the tool that owns the store.',
    };
  }

  const secrets = deps.secrets;
  const removed: string[] = [];
  for (const item of present) {
    await secrets.delete(ITEM_SECRET_KEYS[item]);
    removed.push(ITEM_LABELS[item]);
    // The config reference is cleared alongside the value it points at, or the
    // machine is left claiming a credential that is no longer there — which is
    // the half-landed state connection-repair.ts exists to clean up after.
    if (item === 'refresh-token') deps.config.set(GOOGLE_CONFIG_KEYS.oauthRefreshToken, '');
    if (item === 'client-secret') deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, '');
    if (item === 'app-password') deps.config.set(GOOGLE_CONFIG_KEYS.emailPasswordRef, '');
    if (item === 'calendar-address') deps.config.set(GOOGLE_CONFIG_KEYS.calendarIcsUrl, '');
  }

  return {
    confirmed: true,
    removed,
    wouldRemove: [],
    detail: `Removed ${removed.join(', ')} from the encrypted store. Nothing else was touched.`,
  };
}
