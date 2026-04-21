# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.21.x (latest) | :white_check_mark: |
| < 0.21.0 | :x: |

Pre-1.0 policy: security fixes land in the 0.21.x line. Earlier minor lines (0.19.x, 0.20.x) are not patched; upgrade to the latest 0.21.x release to receive security updates.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Report security issues privately via the main GoodVibes security channel:

- **Email**: mgd34msu@gmail.com (subject: `[SECURITY] goodvibes-sdk <brief description>`)
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

When building with this SDK:

- Prefer bearer tokens for service-to-service and mobile companion clients
- Use secure storage for persisted tokens
- Avoid logging raw credentials or bearer tokens
- Treat structured error fields as telemetry/debug metadata — do not expose directly to end users without review
- Validate CORS and cookie/session assumptions explicitly when using browser session auth
