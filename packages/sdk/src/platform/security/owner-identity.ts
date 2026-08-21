/**
 * owner-identity.ts, who "the owner" is, for the one exemption that names them.
 *
 * ── Why an exemption exists at all ────────────────────────────────────────
 *
 * The taint rule refuses an outward action whose content derives from
 * untrusted input. Applied without exception it refuses the most ordinary
 * thing an assistant that reads mail does: telling the owner what arrived.
 * "What came in overnight" is a summary that NECESSARILY reuses the words of
 * what came in, so it trips the check every time.
 *
 * The owner is the trust root, not a third party. Sending them a summary is
 * not an outward effect in the sense the rule guards, it is the assistant
 * reporting, which is the point of it reading their mail at all.
 *
 * So exactly one exemption: a send whose every recipient is the owner alone.
 *
 * ── What the exemption is NOT ─────────────────────────────────────────────
 *
 *  - Not a domain. `@example.com` would exempt every colleague, and a
 *    forward to a colleague is a third-party disclosure.
 *  - Not a pattern. No plus-address matching, no prefix rules. An alias the
 *    agent minted for a signup is not a channel for reporting.
 *  - Not "internal". There is no such tier; see security/untrusted-content.ts.
 *  - Not partial. A send addressed to the owner AND anyone else is NOT exempt,
 *    because that is precisely how an attacker would use it: name the owner
 *    first and slip a second recipient in beside them.
 *
 * ── Where the identity comes from, and what it would take to spoof ────────
 *
 * ONLY from configuration the owner set, read through an injected reader:
 * `email.fromAddress`, `email.username`, and the daemon's own
 * `surfaces.email.from` / `.user` / `.username`.
 *
 * Never from anything a message can influence, not a `From:` header, not
 * `Reply-To:`, not delivery evidence, not the ledger, not the body. A
 * recipient the content chose is the attack, so content is not consulted.
 *
 * To spoof this an attacker must change the owner's stored mail configuration.
 * That requires either an authenticated write to the daemon's config API, or
 * inducing the agent to call a config-setting tool. Both are strictly stronger
 * capabilities than sending mail: anything able to rewrite daemon config can
 * also disable this guard outright, repoint the SMTP server, or read the
 * credential store. The exemption is therefore not the weakest link in its own
 * chain, it sits behind a capability that already implies compromise.
 *
 * What it does NOT survive: an owner who has never configured a from-address.
 * Then there is no owner identity, `ownerAddresses` is empty, and the
 * exemption cannot fire, the refusal stays. That is the correct failure
 * direction, and it is why this returns a set rather than a best guess.
 */

/** Reads a configuration value. Never reads message content. */
export type OwnerConfigReader = (key: string) => unknown;

/**
 * The config paths that name the owner's own mailbox.
 *
 * All are daemon-owned (see config/config-ownership.ts), so they resolve from
 * the daemon tier rather than from whichever surface happened to be running.
 */
export const OWNER_ADDRESS_CONFIG_KEYS: readonly string[] = [
  'email.fromAddress',
  'email.username',
  'surfaces.email.from',
  'surfaces.email.user',
  'surfaces.email.username',
];

/** Lowercase, strip a display name and angle brackets. No plus-address folding. */
export function normalizeOwnerAddress(value: string): string {
  const trimmed = value.trim();
  const angled = /<([^<>]+)>\s*$/.exec(trimmed);
  return (angled?.[1] ?? trimmed).replace(/^<|>$/g, '').trim().toLowerCase();
}

/** Looks like an address at all, a bare word is not an identity. */
function isAddressShaped(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The owner's own addresses, from configuration only.
 *
 * Empty when nothing is configured, which disables the exemption rather than
 * widening it.
 */
export function resolveOwnerAddresses(getConfig: OwnerConfigReader): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const key of OWNER_ADDRESS_CONFIG_KEYS) {
    let raw: unknown;
    try {
      raw = getConfig(key);
    } catch {
      // An absent config section reads as "not configured", never as a throw,
      // the same guard the connector uses everywhere else.
      continue;
    }
    if (typeof raw !== 'string') continue;
    const address = normalizeOwnerAddress(raw);
    if (address.length > 0 && isAddressShaped(address)) addresses.add(address);
  }
  return addresses;
}

/**
 * Split a recipient field into individual addresses.
 *
 * A single `to` string can carry several recipients. Treating it as one opaque
 * value is how "the owner, and also the attacker" would pass.
 */
export function splitRecipients(recipientField: string): readonly string[] {
  return recipientField
    .split(',')
    .map((entry) => normalizeOwnerAddress(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * True when EVERY recipient is the owner alone.
 *
 * `false` for an empty recipient list and for an empty owner set: an exemption
 * that fires on "nothing configured" or "nobody addressed" is an exemption
 * that fires by accident.
 */
export function isSendToOwnerOnly(
  recipientField: string | undefined,
  ownerAddresses: ReadonlySet<string>,
): boolean {
  if (recipientField === undefined || ownerAddresses.size === 0) return false;
  const recipients = splitRecipients(recipientField);
  if (recipients.length === 0) return false;
  return recipients.every((recipient) => ownerAddresses.has(recipient));
}
