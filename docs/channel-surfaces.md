# Channel surfaces

Channel surfaces connect external messaging systems and automation sources to
the daemon. They provide ingress, delivery, policy, account lifecycle, directory
lookup, route binding, and surface-specific tools.

Public API surfaces:

- `@pellux/goodvibes-sdk/platform/channels` (channel surface contract; home of the `ChannelSurface`, `ChannelRenderPolicy`, and `ChannelRouteBinding` types)
- `@pellux/goodvibes-sdk/platform/daemon` (daemon HTTP routes)
- `@pellux/goodvibes-sdk/platform/integrations` (notifier integrations)
- operator control-plane methods for channel setup, delivery, and route binding

## Supported surfaces

The `ChannelSurface` contract names every conversational or notification
system the daemon can sit behind. `tui` and `web` are the two first-party
surfaces the daemon itself ships; everything else is a built-in managed
external surface, meaning the daemon owns its account setup, ingress, and
delivery rather than treating it as a generic webhook target.

| Surface | What it is |
|---|---|
| `tui` | The daemon's own terminal UI, treated as a channel like any other for routing purposes. |
| `web` | The browser-facing operator surface. |
| `slack` | A Slack app, driven over bot/app-level tokens and Socket Mode. |
| `discord` | A Discord bot, driven over gateway dispatch and interactions. |
| `ntfy` | Push notifications and chat over the ntfy pub/sub protocol. |
| `webhook` | A generic signed inbound/outbound webhook connector for systems with no dedicated adapter. |
| `homeassistant` | Home Assistant, over its REST API, webhooks, and Assist conversation protocol. |
| `telegram` | A Telegram bot, over `getUpdates` polling or a registered webhook. |
| `google-chat` | A Google Chat app, over webhook events. |
| `signal` | The Signal messenger. |
| `whatsapp` | WhatsApp Business messaging. |
| `telephony` | SMS and voice, either through a bridge or direct Twilio calls. |
| `imessage` | iMessage. |
| `msteams` | Microsoft Teams. |
| `bluebubbles` | iMessage reached through a BlueBubbles server. |
| `mattermost` | Mattermost. |
| `matrix` | The Matrix protocol. |

## Capabilities

Channel capabilities are declared per adapter, and the channel runtime uses
them to decide which setup fields, operator actions, tools, directory
queries, and delivery routes are available for that surface.

| Capability | What it grants |
|---|---|
| `ingress` | The adapter can receive inbound messages or events from the provider. |
| `egress` | The adapter can deliver outbound messages to the provider. |
| `threaded_reply` | Replies can be posted inside a thread rather than only at the top level of a conversation. |
| `interactive_actions` | The provider's interactive elements (buttons, components, commands) are supported. |
| `session_binding` | An external conversation can be bound to daemon runtime state (a route binding), so follow-ups return to the right place. |
| `delivery_only` | Replies can be delivered without an interactive, session-bound conversation, the shape notification and webhook-style channels need. |
| `account_lifecycle` | The surface exposes account setup, connect/disconnect, and repair actions rather than being config-only. |
| `target_resolution` | A human-readable target (a user, channel, or group) can be resolved to a concrete delivery address before dispatch. |
| `agent_tools` | The surface contributes tool definitions into GoodVibes agent runtimes. |

The channel runtime uses these capabilities to decide which setup fields,
operator actions, tools, directory queries, and delivery routes are available.

## Ingress

Adapters parse provider-specific payloads into GoodVibes work:

- Slack webhook and Socket Mode payloads
- Discord webhooks, interactions, and gateway dispatches
- ntfy JSON stream messages
- Home Assistant signed webhooks and Assist conversation requests
- Telegram webhook updates
- Google Chat webhook events
- Signal, WhatsApp, Telephony, iMessage, BlueBubbles, Mattermost, Matrix, and
  generic webhook payloads
- GitHub automation webhooks

Ingress applies request-size limits, signature/token checks where configured,
channel policy, conversation-kind mapping, route binding, and surface-specific
reply setup before handing work to the daemon.

## Conversation kinds

Channel conversation kinds are:

- direct
- group
- channel
- thread
- service

Policies can match at surface or group scope. The default policy posture is
allow/deny/inherit by conversation kind, with command allowlists and actor
authorization records available for managed surfaces.

## Route bindings

Route bindings preserve the connection between an external conversation and
GoodVibes runtime state. A binding can include surface kind, surface id,
external id, thread id, channel id, session id, automation job/run ids, and
metadata.

Bindings allow follow-up messages, threaded replies, agent progress, approval
responses, and automation deliveries to return to the correct external target.

## Delivery

The delivery router sends runtime output to channel targets. Delivery records
track status, attempts, errors, metadata, and dead-letter posture. The reply
pipeline listens to turn, agent, and workflow events and renders progress,
approval, and final messages according to the channel render policy.

Channel render policy controls:

- reasoning visibility: suppress, private, public, or summary
- output format: plain, Markdown, or JSON
- phase: progress, final, or approval

## Account lifecycle

Managed surfaces expose account records, secret status, setup schemas, repair
actions, doctor reports, lifecycle state, allowlist resolution, allowlist edit,
directory lookup, target resolution, and account actions.

Account lifecycle actions include inspect, setup, retest, connect, disconnect,
start, stop, login, logout, and wait-login. A secret's reported source is one
of the service registry, config, environment variables, or a derived value;
`unresolved` marks a value that is declared but resolves to nothing, distinct
from `missing`, which marks a value that was never declared at all.

## Directory and targets

Directory entries represent self, users, channels, groups, threads, members,
and services. Target resolution can use explicit input, provider directories,
route bindings, normalized identifiers, synthetic targets, or miss records.

This is what lets a client resolve names like a Slack channel, Discord thread,
or Home Assistant service target before dispatching work.

## Surface-specific notes

- ntfy has configurable chat, agent, and remote-chat topics. Chat-to-TUI routes
  into the active shared session; agent topics submit agent work; remote-chat
  topics use daemon-owned remote chat and inherit the daemon/TUI provider/model.
- Home Assistant uses signed ingress, isolated remote sessions, Assist
  submit-and-wait conversation routes, event-bus delivery, setup manifest
  discovery, REST-backed tools, and an inactivity TTL for remote sessions.
- Slack uses bot and app-level tokens, Socket Mode runtime, final delivery with
  bot-token resolution, and service-backed secret refs.
- Discord supports interactions, gateway dispatch, commands, and component
  responses.
- Telephony supports bridge-backed SMS/voice delivery or direct Twilio SMS/voice
  calls, token-authenticated inbound callbacks, default recipient routing, and
  plain-text reply rendering tuned for phone channels.
- Generic webhooks support signed ingress and generic reply delivery.

## Operator methods

The operator contract exposes channel surfaces, accounts, setup schemas,
doctor reports, repairs, lifecycle state, directory lookup, target resolution,
policies, allowlists, route bindings, and delivery inspection. The generated
[Operator API reference](./reference-operator.md) is the exact method/schema
inventory.
