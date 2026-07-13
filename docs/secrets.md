# Secret References

GoodVibes config values can point at secrets without embedding secret material
directly in config files. The SDK-owned URI form is `goodvibes://`.

**Public subpath:** `@pellux/goodvibes-sdk/platform/config` (daemon embedders).

## Supported Sources

| Source | Purpose |
|---|---|
| `env` | Read from an environment variable |
| `goodvibes` | Resolve from the local GoodVibes secret store supplied by the host |
| `file` | Read from a file path, with optional selector support |
| `exec` | Run a command and use its stdout as the secret |
| `1password` / `onepassword` | Resolve through the 1Password CLI/native reference shape |
| `bitwarden` | Resolve through the Bitwarden CLI |
| `vaultwarden` | Resolve through Bitwarden CLI against a Vaultwarden server |
| `bitwarden-secrets-manager` / `bws` | Resolve through Bitwarden Secrets Manager |

The removed generic `secret://` scheme is not supported. Use
`goodvibes://secrets/...` for SDK-owned secret references.

## URI Shape

```text
goodvibes://secrets/<source>/<id-or-path>?key=value
```

Examples:

```text
goodvibes://secrets/env/OPENAI_API_KEY
goodvibes://secrets/goodvibes/GOODVIBES_WORKER_TOKEN
goodvibes://secrets/file/%2Fhome%2Fme%2F.token
goodvibes://secrets/1password?vault=Private&item=OpenAI&field=password
goodvibes://secrets/bitwarden/My%20Login?field=password
goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000
```

JSON-style references are also supported through the `secretref:` prefix when
clients need structured fields that do not fit naturally in a URI.

## Resolution

`resolveSecretRef()` returns `{ source, value }`. A `null` value means the
reference parsed but the backing secret was unavailable.

Hosts can provide:

- `resolveLocalSecret` for `goodvibes` refs.
- `runCommand` for CLI-backed providers.
- `homeDirectory` for `~` expansion in file refs.

CLI-backed refs support timeouts and provider-specific options. Command
execution is host-owned so embedders can apply their own permission prompts,
logging, and sandboxing.

## Config Usage

Secret refs are used by provider keys, surface credentials, Cloudflare tokens,
Worker/client tokens, Tunnel tokens, Access service tokens, webhook secrets,
and other daemon-owned integration credentials.

Store secret refs in config; store the secret values in the backing secret
provider.

## Live provider credentials

Provider API keys resolve through one request-time chain: environment
variable → secrets store → subscription accounts. Writing, rotating, or
deleting a key in the secrets store re-registers the affected providers in
the same process (`SecretsManager.onDidChange` →
`ProviderRegistry.refreshProviderCredentials()`), so a provider becomes
usable the moment its key is stored — no restart anywhere. Status badges,
the model picker, and chat all read the same refreshed provider instances,
so status can never be green while chat fails auth. Every registered
provider must declare how its credentials are obtained
(`credentialAuthority: 'resolver' | 'anonymous' | 'subscription' | 'oauth'`);
registration is refused otherwise.

## Related

This page is the canonical reference for the secret sources and `goodvibes://` URI syntax. For how secret refs and the `SecretsManager` storage layers fit the daemon security model, see [Security Best Practices](./security.md).
