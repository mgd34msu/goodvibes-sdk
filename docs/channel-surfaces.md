# Channel Surfaces

Channel surfaces connect external messaging systems and automation sources to
the daemon. They provide ingress, delivery, policy, account lifecycle, directory
lookup, route binding, and surface-specific tools.

Sources:

- `packages/sdk/src/_internal/platform/channels/`
- `packages/sdk/src/_internal/platform/adapters/`
- `packages/sdk/src/_internal/platform/daemon/http/channel-routes.ts`
- `packages/sdk/src/_internal/platform/control-plane/method-catalog-channels.ts`

## Supported Surfaces

The channel contract includes:

- `tui`
- `web`
- `slack`
- `discord`
- `ntfy`
- `webhook`
- `homeassistant`
- `telegram`
- `google-chat`
- `signal`
- `whatsapp`
- `imessage`
- `msteams`
- `bluebubbles`
- `mattermost`
- `matrix`

Built-in managed external surfaces are Slack, Discord, ntfy, generic webhook,
Home Assistant, Telegram, Google Chat, Signal, WhatsApp, iMessage, Microsoft
Teams, BlueBubbles, Mattermost, and Matrix.

## Capabilities

Channel capabilities are declared per adapter:

- ingress
- egress
- threaded reply
- interactive actions
- session binding
- delivery-only mode
- account lifecycle
- target resolution
- agent tools

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
- Signal, WhatsApp, iMessage, BlueBubbles, Mattermost, Matrix, and generic
  webhook payloads
- GitHub automation webhooks

Ingress applies request-size limits, signature/token checks where configured,
channel policy, conversation-kind mapping, route binding, and surface-specific
reply setup before handing work to the daemon.

## Conversation Kinds

Channel conversation kinds are:

- direct
- group
- channel
- thread
- service

Policies can match at surface or group scope. The default policy posture is
allow/deny/inherit by conversation kind, with command allowlists and actor
authorization records available for managed surfaces.

## Route Bindings

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

## Account Lifecycle

Managed surfaces expose account records, secret status, setup schemas, repair
actions, doctor reports, lifecycle state, allowlist resolution, allowlist edit,
directory lookup, target resolution, and account actions.

Account lifecycle actions include inspect, setup, retest, connect, disconnect,
start, stop, login, logout, and wait-login. Secrets can be read from the
service registry, config, environment variables, derived values, or reported as
missing.

## Directory And Targets

Directory entries represent self, users, channels, groups, threads, members,
and services. Target resolution can use explicit input, provider directories,
route bindings, normalized identifiers, synthetic targets, or miss records.

This is what lets a client resolve names like a Slack channel, Discord thread,
or Home Assistant service target before dispatching work.

## Surface-Specific Notes

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
- Generic webhooks support signed ingress and generic reply delivery.

## Operator Methods

The operator contract exposes channel surfaces, accounts, setup schemas,
doctor reports, repairs, lifecycle state, directory lookup, target resolution,
policies, allowlists, route bindings, and delivery inspection. The generated
[Operator API reference](./reference-operator.md) is the exact method/schema
inventory.
