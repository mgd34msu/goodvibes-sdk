# Auth Architecture

Auth is split between client token handling and daemon route enforcement.

Client-facing code uses token stores and transport middleware. Daemon-facing
code resolves principals, scopes, sessions, and admin requirements. Transport
helpers do not read process-wide config or environment state implicitly; callers
provide tokens, token stores, or resolvers.

Examples must not print tokens or hardcode real credentials. Test credentials
should be local placeholders or environment-driven.
