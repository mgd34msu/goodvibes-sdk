# Telegram integration

Telegram support is an SDK-owned daemon surface. A Telegram bot becomes a way to
send the daemon work from a phone and get replies back, without exposing the
daemon to the internet.

The adapter stays inactive until its surface settings enable and configure it:

```json
{
  "surfaces": {
    "telegram": {
      "enabled": true,
      "mode": "polling",
      "botToken": "goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN"
    }
  }
}
```

References:

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [getUpdates](https://core.telegram.org/bots/api#getupdates)
- [setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [BotFather](https://core.telegram.org/bots/features#botfather)

## Two ingress modes, and which one you want

Telegram never pushes messages to a bot uninvited. The daemon has to establish
inbound delivery in one of exactly two ways, chosen by
`surfaces.telegram.mode`:

| Mode | How updates arrive | Needs a public URL? | Use when |
|---|---|---|---|
| `polling` | The daemon long-polls `getUpdates` | No | The daemon runs on a laptop, a home server, or anything behind NAT, the common case |
| `webhook` | Telegram POSTs to `/webhook/telegram` | Yes, public HTTPS | The daemon is already published at a public HTTPS address |

**The two modes are mutually exclusive.** Telegram answers `getUpdates` with
`409 Conflict` while a webhook is registered. The daemon enforces this rather
than assuming it: polling mode deletes any registered webhook before its first
poll, and webhook mode never starts a poll loop. Whichever mode is active is
logged at startup with the reason.

If you are not sure, use `polling`. It works everywhere, needs no inbound
firewall rule, no tunnel, and no certificate.

> **Note on the default.** `surfaces.telegram.mode` currently defaults to
> `webhook`. On a machine with no public HTTPS address that default cannot
> start, and the daemon will log an inactive-with-reason warning at startup
> pointing you here. Set `mode` to `polling` explicitly for a local daemon.

## Step 1: create a bot and get a token

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Give it a display name (anything) and then a username, which must end in
   `bot`: for example `mikes_goodvibes_bot`.
4. BotFather replies with a token that looks like
   `123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`.

The digits before the colon are the bot id and are not sensitive. Everything
after the colon is. Anyone holding the whole token controls the bot.

While you are in BotFather, two optional settings make the bot nicer to use:

- `/setprivacy` → **Disable** if you want the bot to see all group messages
  rather than only ones addressed to it. Leave it enabled (the default) for the
  safer behaviour, where the bot only sees `/commands` and replies aimed at it.
- `/setcommands` → paste the following so Telegram's UI offers them:

  ```
  start - Connect and show how to use this bot
  help - Show how to talk to the bot
  stop - Stop the current task
  ```

## Step 2: store the token

Store the token as a secret rather than pasting it into a settings file.
`surfaces.telegram.botToken` accepts either a literal token or a
`goodvibes://` secret reference, and the reference is resolved at use time:

```json
{
  "surfaces": {
    "telegram": {
      "botToken": "goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN"
    }
  }
}
```

The `TELEGRAM_BOT_TOKEN` environment variable is also honoured, and a
`telegram` entry in the service registry takes precedence over both.

Resolution order for the bot token:

1. Service registry: `telegram` or `primary`
2. `surfaces.telegram.botToken` (literal or `goodvibes://` reference)
3. `TELEGRAM_BOT_TOKEN`

### Which config file: this trips people up

The daemon reads its own surface-scoped settings, **not** the ones belonging to
another GoodVibes surface. Each host owns a separate `.goodvibes/<surface>/`
tree, and they are not shared:

| Host | Settings file it reads | Secrets store |
|---|---|---|
| `goodvibes-daemon` | `~/.goodvibes/goodvibes/settings.json` | `~/.goodvibes/goodvibes/secrets.enc` |
| `goodvibes-agent` | `~/.goodvibes/agent/settings.json` | `~/.goodvibes/agent/secrets.enc` |

Setting a Telegram bot token inside `goodvibes-agent` writes it to the **agent's**
tree. The daemon does not read that file, and nothing copies the value across.
There is no config push between them. If you want the daemon to receive Telegram
messages, set the token in the daemon's own settings, or via
`TELEGRAM_BOT_TOKEN` in the daemon's environment.

## Step 3: enable the surface

### Polling mode (no public URL)

```json
{
  "surfaces": {
    "telegram": {
      "enabled": true,
      "mode": "polling",
      "botToken": "goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN",
      "botUsername": "mikes_goodvibes_bot"
    }
  }
}
```

That is the whole setup. On start the daemon deletes any stale webhook, begins
long-polling, and logs:

```
Telegram ingress active  mode=polling  reason=long-polling Telegram getUpdates for bot 123456789 (no public URL required)
```

Polling holds one HTTP request open against Telegram for up to 25 seconds at a
time, so it is close to idle when nothing is happening. It is not a busy loop.

### Webhook mode (public HTTPS required)

Webhook mode needs an address **Telegram's servers** can reach. That means:

- `https://`: Telegram will not deliver to plain HTTP.
- A publicly resolvable hostname. `localhost`, `127.0.0.1`, `192.168.x.x`,
  `10.x.x.x`, `172.16–31.x.x`, and `*.local` are all rejected up front, because
  registering a webhook Telegram can never deliver to produces a surface that
  looks configured and silently receives nothing.
- A valid certificate.

Configure it with the daemon's public base URL and a secret token:

```json
{
  "web": { "publicBaseUrl": "https://daemon.example.com" },
  "surfaces": {
    "telegram": {
      "enabled": true,
      "mode": "webhook",
      "botToken": "goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN",
      "webhookSecret": "goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_WEBHOOK_SECRET"
    }
  }
}
```

On start the daemon calls `setWebhook` with
`{publicBaseUrl}/webhook/telegram` and the secret token.

**The secret token matters.** Telegram sends it back on every delivery in the
`x-telegram-bot-api-secret-token` header, and the daemon rejects any inbound
call whose header does not match. Without it, the webhook endpoint accepts
anything that finds the URL. The daemon logs a warning if you register a webhook
without one.

If you need webhook mode but have no public address, put a tunnel in front of the
daemon (Cloudflare Tunnel, Tailscale Funnel, ngrok, or a reverse proxy on a VPS)
and set `web.publicBaseUrl` to the tunnel's public HTTPS URL. Or just use
`polling`, which is what the tunnel is working around.

## Config keys

| Key | Default | Purpose |
|---|---:|---|
| `surfaces.telegram.enabled` | `false` | Enables the Telegram surface. Nothing runs until this is true. |
| `surfaces.telegram.mode` | `"webhook"` | Ingress mode: `polling` or `webhook`. See the note above about the default. |
| `surfaces.telegram.botToken` | `""` | BotFather token, or a `goodvibes://` secret reference. |
| `surfaces.telegram.webhookSecret` | `""` | Shared secret verified on inbound webhook calls. Webhook mode only. |
| `surfaces.telegram.botUsername` | `""` | The bot's `@name`, used for mention matching and `/command@bot` handling in groups. |
| `surfaces.telegram.defaultChatId` | `""` | Chat, group, or channel id used for outbound delivery when no route binding applies. |
| `web.publicBaseUrl` | `"http://127.0.0.1:3423"` | The daemon's public base URL. Webhook mode builds the delivery URL from it. |

Environment fallbacks: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`.

## Talking to the bot

In a **direct chat**, every message you send is a task. Just type it.

In a **group**, the bot only acts on messages addressed to it:

- `/goodvibes check the build`: the `/goodvibes` prefix is stripped, and
  `check the build` becomes the task.
- `@mikes_goodvibes_bot check the build`

Standard Telegram commands are handled as onboarding and never dispatched as
work:

| Command | Behaviour |
|---|---|
| `/start` | Binds the chat as a route and replies with usage. This is what Telegram sends when a user taps **Start**. |
| `/help` | Replies with the same usage summary. |
| `/stop` | Explains how to cancel a running task and how to disconnect the surface. |

While a task is running:

- `status <id>`: progress
- `cancel <id>`: stop it
- `retry <id>`: run it again after a failure

## Verifying it works

1. **Check the startup log.** The daemon logs exactly one of:

   - `Telegram ingress active  mode=polling …`
   - `Telegram ingress active  mode=webhook …`
   - `Telegram ingress is not receiving messages  reason=…`

   The third one names what to fix. A configured surface never fails silently.

2. **Send `/start` to your bot.** You should get the usage reply back within a
   couple of seconds. This exercises the full inbound path, Telegram to daemon,
   route binding, and the outbound reply, without spawning an agent.

3. **Send a real task**, for example `what is the current git branch`. You
   should see the agent spawn in the daemon log and a reply in the chat.

4. **Webhook mode only.** Ask Telegram what it thinks is registered:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```

   `url` should be your `{publicBaseUrl}/webhook/telegram`, `pending_update_count`
   should be near zero, and `last_error_message` should be absent. A populated
   `last_error_message` is Telegram telling you exactly why delivery failed,
   usually a certificate or DNS problem.

5. **Polling mode only.** `getWebhookInfo` should show an empty `url`. If it
   does not, something re-registered a webhook and polling will report a
   conflict.

## Troubleshooting

**Nothing happens when I message the bot.**
Check the startup log first. If it says the ingress is inactive, the reason names
the setting to change. The two most common causes are `mode=webhook` on a machine
with no public URL, and a token set in `goodvibes-agent` rather than in the
daemon's own settings (see "Which config file" above).

**`409 Conflict: can't use getUpdates method while webhook is active`.**
A webhook is registered for this bot, so polling cannot run. The daemon clears it
automatically and retries. If it cannot clear it after several attempts it stops
with a message saying so rather than retrying forever. That usually means a
second process (another daemon, or an old deployment) is re-registering the
webhook against the same bot token. One bot token supports exactly one ingress.

**`401 Unauthorized`.**
The token is wrong, revoked, or has stray whitespace. The daemon stops polling
immediately instead of retrying, because retrying cannot fix it. Get a fresh
token from BotFather with `/token`.

**The bot ignores me in a group.**
Either address it explicitly (`/goodvibes …` or `@yourbot …`), or turn off
privacy mode in BotFather with `/setprivacy`. With privacy mode on, the default,
Telegram does not even deliver ordinary group messages to the bot.

**Messages sent while the daemon was down.**
Telegram retains undelivered updates for about 24 hours, and polling picks up
that backlog on the next start. The read cursor is persisted at
`.goodvibes/goodvibes/channels/telegram-offset.json`, so a restart resumes
exactly where it stopped rather than replaying or skipping. If that file is ever
found torn, a crash mid-write, the daemon logs the fact and skips ahead to the
newest message instead of replaying the backlog, because re-running work that
already ran is worse than missing a message you can resend.

**Switching from webhook to polling (or back).**
Just change `surfaces.telegram.mode` and restart. The daemon reconciles the
Telegram-side registration for you, and does not drop pending updates when it
removes a webhook.
