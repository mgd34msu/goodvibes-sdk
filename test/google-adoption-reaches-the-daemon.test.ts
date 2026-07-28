/**
 * The owner's live failure, end to end, in a throwaway home.
 *
 * What happened on his machine: he ran `/google adopt` in goodvibes-agent and it
 * reported success. He then messaged the bot on Telegram — served by the daemon,
 * with the agent closed — and was told "I can't send the email from this session
 * because no email integration is available."
 *
 * His standing rule: "anything configured on one of the surfaces is
 * automatically available to be used by the daemon, even after the surface
 * interaction point has closed."
 *
 * So this test does exactly that and nothing else:
 *
 *   1. Put credentials on the machine where another tool would leave them
 *      (`~/.gmail-mcp`), in a home that exists only for this test.
 *   2. Adopt them through the AGENT's config and secret managers — the real
 *      `adoptExistingGoogleCredentials`, not a stand-in.
 *   3. Throw those managers away. The agent is closed.
 *   4. Build the DAEMON's own managers over the same home and ask the same
 *      question the daemon asks: is a Google account connected, and can it
 *      send mail.
 *
 * Step 4 is the deliverable. Unit tests on scope routing pass whether or not
 * the two halves of a credential end up in the same place; only asking the
 * daemon shows that they did.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import {
  adoptExistingGoogleCredentials,
  detectGoogleSetupState,
  ensureGoogleConfigDefaults,
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
} from '../packages/sdk/src/platform/google/index.ts';
import { ensureEmailConfigDefaults } from '../packages/sdk/src/platform/email/index.ts';
import type { GoogleConfigPort, GoogleFilePort, GoogleSecretPort } from '../packages/sdk/src/platform/google/types.ts';
import { readFileSync, existsSync } from 'node:fs';

/** Fake, structurally valid, and obviously not a real credential. */
const FAKE_CLIENT_ID = '111222333444-testonlyclientid.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'TEST-ONLY-not-a-real-client-secret';
const FAKE_REFRESH_TOKEN = '1//TEST-ONLY-not-a-real-refresh-token';

function throwawayHome(): string {
  return mkdtempSync(join(tmpdir(), 'gv-google-adopt-'));
}

/** Credentials another tool already left on this machine. */
function seedGmailMcp(home: string): void {
  const root = join(home, '.gmail-mcp');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'gcp-oauth.keys.json'), JSON.stringify({
    installed: {
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  }));
  writeFileSync(join(root, 'google-workspace-credentials.json'), JSON.stringify({
    refresh_token: FAKE_REFRESH_TOKEN,
    access_token: 'TEST-ONLY-access-token',
    expiry_date: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar',
  }));
}

const nodeFiles: GoogleFilePort = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try { return readFileSync(path, 'utf-8'); } catch { return null; }
  },
};

/**
 * One surface's view of the machine: its own config silo and its own secret
 * store, exactly as that product builds them.
 */
function surface(home: string, surfaceRoot: string) {
  const configManager = new ConfigManager({ homeDir: home, surfaceRoot });
  // The connector spans three app-layer sections; the real wiring seeds them
  // before any access, so this does too.
  ensureGoogleConfigDefaults(configManager);
  ensureEmailConfigDefaults(configManager);
  const secretsManager = new SecretsManager({
    projectRoot: join(home, 'workdir'),
    globalHome: home,
    surfaceRoot,
    policy: 'plaintext_allowed',
  });
  const config: GoogleConfigPort = {
    get: (key) => configManager.get(key as never),
    // No scope forced — the ownership machinery decides, which is the whole
    // contract GoogleConfigPort documents.
    set: (key, value) => { configManager.setDynamic(key as never, value); },
  };
  const secrets: GoogleSecretPort = {
    get: (key) => secretsManager.get(key),
    set: (key, value) => secretsManager.set(key, value),
  };
  return { configManager, secretsManager, config, secrets };
}

describe("a credential adopted in the agent is the daemon's to use", () => {
  test('adopt in the agent, close it, and the daemon reports the account connected', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);

    // ── 1. The agent adopts. ────────────────────────────────────────────────
    const agent = surface(home, 'agent');
    const outcome = await adoptExistingGoogleCredentials({
      files: nodeFiles,
      config: agent.config,
      secrets: agent.secrets,
      homeDirectory: home,
    });
    expect(outcome.adopted).toBe(true);

    // ── 2. The agent is closed. Nothing of it survives into step 3. ─────────
    //    Fresh managers below read only what is on disk.

    // ── 3. The daemon asks its own question. ───────────────────────────────
    const daemon = surface(home, 'daemon');
    const state = await detectGoogleSetupState({ config: daemon.config, secrets: daemon.secrets });

    // This is the assertion the owner's incident is about. Before the fix the
    // daemon saw nothing here and the model, reasoning from that emptiness,
    // told him no email integration was available.
    expect(state.oauthClientId).toBe(FAKE_CLIENT_ID);
    expect(state.hasOAuthClientSecret).toBe(true);
    expect(state.hasRefreshToken).toBe(true);
  });

  test('a THIRD surface that never touched the credential reads the same answer', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);
    const agent = surface(home, 'agent');
    await adoptExistingGoogleCredentials({
      files: nodeFiles, config: agent.config, secrets: agent.secrets, homeDirectory: home,
    });

    // The TUI was never open during setup. It must still see the connection —
    // "everything gets everything for free" is the same rule read from the
    // other end.
    const tui = surface(home, 'tui');
    const state = await detectGoogleSetupState({ config: tui.config, secrets: tui.secrets });
    expect(state.oauthClientId).toBe(FAKE_CLIENT_ID);
    expect(state.hasRefreshToken).toBe(true);
  });

  test('the credential physically lands in the daemon tier, not the agent silo', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);
    const agent = surface(home, 'agent');
    await adoptExistingGoogleCredentials({
      files: nodeFiles, config: agent.config, secrets: agent.secrets, homeDirectory: home,
    });

    // The secret half.
    const records = await agent.secretsManager.listDetailed();
    for (const key of [GOOGLE_SECRET_KEYS.oauthClientSecret, GOOGLE_SECRET_KEYS.oauthRefreshToken]) {
      const record = records.find((entry) => entry.key === key && entry.source !== 'env');
      expect(record?.scope).toBe('daemon');
    }

    // The config half. A client id stranded in a surface silo leaves the daemon
    // holding half a credential, which reports as "no account connected" just
    // as loudly as holding none.
    const daemonSettings = join(home, '.goodvibes', 'daemon', 'settings.json');
    expect(existsSync(daemonSettings)).toBe(true);
    const stored = JSON.parse(readFileSync(daemonSettings, 'utf-8')) as Record<string, unknown>;
    const calendar = (stored['calendar'] ?? {}) as Record<string, Record<string, unknown>>;
    expect(calendar['google']?.['clientId']).toBe(FAKE_CLIENT_ID);
    expect(calendar['google']?.['clientSecretRef']).toBe(GOOGLE_CONFIG_KEYS.oauthClientSecretRef);
  });
});
