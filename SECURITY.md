# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest published pre-1.0 minor line | :white_check_mark: |
| Earlier pre-1.0 minor lines | :x: |

Pre-1.0 policy: security fixes land in the latest published pre-1.0 line. Earlier minor lines are not patched; upgrade to the latest release to receive security updates.

## Dependency Audit Disclosures

The repo uses package-manager overrides for transitive advisory remediation when
the upstream dependency range has not yet moved but a compatible fixed package is
available. Current non-vendored overrides are declared in the root
`package.json`:

- `fast-xml-parser@5.7.1` for the AWS XML builder path
- `ajv@8.18.0` for Verdaccio and documentation tooling paths
- `lodash@4.18.1` for Verdaccio storage paths (bumped from `4.17.21` to escape an audit advisory; see root `package.json` overrides)
- `google-auth-library@10.6.2` for Cloudflare/Wrangler transitive auth tooling
- `minimatch@^10.2.5` for source-workspace installs
- `fast-uri@3.1.2` to avoid `GHSA-v39h-62p7-jpjc` in AJV consumers used by release tooling
- `esbuild@0.28.1` to close `GHSA-gv7w-rqvm-qjhr` (RCE via missing binary integrity verification in the Deno module path)
- `form-data@4.0.6` to close `GHSA-hmw2-7cc7-3qxx` (CRLF injection via unescaped multipart field/file names)
- `ws@8.21.0` to close `GHSA-96hv-2xvq-fx4p` (memory-exhaustion DoS from tiny fragments)
- `undici@7.28.0` to close `GHSA-vmh5-mc38-953g`, `GHSA-vxpw-j846-p89q`, and `GHSA-hm92-r4w5-c3mj` (TLS bypass, WebSocket DoS, SOCKS5 routing)

The published SDK keeps Bash LSP bundled as a first-class feature. The
`bash-language-server@5.6.0 -> editorconfig@2.0.1 -> minimatch@10.0.1` chain is
handled as a graph-level vendor patch: `vendor/bash-language-server` copies the
upstream `bash-language-server@5.6.0` package and changes only
`dependencies.editorconfig` to `3.0.2`, whose dependency range resolves to the
fixed `minimatch@~10.2.4` line (the root `overrides.minimatch` separately pins
`^10.2.5` for source-workspace installs). Release staging rewrites the published SDK
dependency to `file:vendor/bash-language-server`, so consumer lockfiles and
`npm audit` see the patched graph directly.

No install-time minimatch mutation is used. The Bash LSP mitigation is carried
by the published dependency graph itself.

The `uuid` advisory `GHSA-w5hq-g745-h8pq` is also handled with a vendor patch
because Verdaccio's current stable release still depends on `@cypress/request@3.0.10`,
which depends on `uuid@^8.3.2`. The root workspace overrides that transitive
dependency to `file:vendor/uuid-cjs`, a checked-in CommonJS vendor adapter that
implements only the `v4` surface used by `@cypress/request`. The adapter uses
Node's crypto APIs and includes the same output-buffer bounds check shape used
by the upstream `uuid@14` fix. This vendored package is dev/tooling scope only
for the local Verdaccio registry dry-run and must not be treated as a general
replacement for the upstream `uuid` package.

Application roots that audit the SDK dependency graph should set their own
root-level overrides for the non-vendored packages if their package manager does
not inherit dependency-package overrides:

```json
{
  "overrides": {
    "ajv": "8.18.0",
    "esbuild": "0.28.1",
    "fast-uri": "3.1.2",
    "fast-xml-parser": "5.7.1",
    "form-data": "4.0.6",
    "google-auth-library": "10.6.2",
    "lodash": "4.18.1",
    "minimatch": "^10.2.5",
    "undici": "7.28.0",
    "ws": "8.21.0"
  }
}
```

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Report security issues privately via GitHub private vulnerability reporting:

- **GitHub private vulnerability reporting**: Use the [Security tab](https://github.com/mgd34msu/goodvibes-sdk/security/advisories/new) on this repository

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations (optional)

## Response SLA

| Severity | Initial Response | Fix Target |
|----------|-----------------|------------|
| Critical (CVSS 9.0+) | 24 hours | 7 days |
| High (CVSS 7.0–8.9) | 48 hours | 14 days |
| Medium (CVSS 4.0–6.9) | 5 business days | 30 days |
| Low (CVSS < 4.0) | 10 business days | Best effort |

Reporters will be notified when the vulnerability is confirmed, when a fix is staged, and when a release ships.

## Scope

Security-sensitive areas in this SDK include:

- Bearer-token handling
- Session login flows
- Token persistence adapters
- Realtime event streams
- Daemon route embedding
- Structured error propagation

## Consumer Guidance

For the full security model — authentication modes, token management, secret handling, and daemon hardening — see [docs/security.md](./docs/security.md).

When building with this SDK:

- Prefer bearer tokens for service-to-service and mobile companion clients
- Use secure storage for persisted tokens
- Avoid logging raw credentials or bearer tokens
- Treat structured error fields as telemetry/debug metadata — do not expose directly to end users without review
- Validate CORS and cookie/session assumptions explicitly when using browser session auth
