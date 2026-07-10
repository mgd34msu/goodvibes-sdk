#!/usr/bin/env bash
# Verification for the echo-marker example task: pass (exit 0) iff the session
# created marker.txt in the working directory containing exactly "done".
set -euo pipefail
[ "$(cat marker.txt 2>/dev/null || true)" = "done" ]
