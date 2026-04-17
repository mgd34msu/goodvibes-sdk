#!/usr/bin/env bash
# run-hermes-tests.sh
#
# Orchestrates the full Hermes test run:
#   1. Build the SDK (if dist/ is stale)
#   2. Bundle the Hermes test runner via esbuild (via Bun)
#   3. Execute the bundle under the Hermes binary
#
# Prerequisites:
#   - test/hermes/bin/hermes exists (run setup-hermes.sh first)
#   - bun is on PATH
#
# Usage:
#   bash test/hermes/run-hermes-tests.sh [--no-build]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HERMES_BIN="$SCRIPT_DIR/bin/hermes"
BUNDLE="$SCRIPT_DIR/dist/hermes-test-bundle.js"

# ---- guards ----------------------------------------------------------------
if [ ! -f "$HERMES_BIN" ]; then
  echo "ERROR: Hermes binary not found at $HERMES_BIN"
  echo "Run: bash test/hermes/setup-hermes.sh"
  exit 1
fi

# ---- optional build --------------------------------------------------------
NO_BUILD=""
for arg in "$@"; do
  if [ "$arg" = "--no-build" ]; then NO_BUILD=1; fi
done

if [ -z "$NO_BUILD" ]; then
  echo "[hermes] Building SDK dist..."
  bun run build --cwd "$REPO_ROOT"
else
  # --no-build was passed: verify dist exists before proceeding
  if [ ! -f "$REPO_ROOT/packages/sdk/dist/index.js" ]; then
    echo "ERROR: --no-build was passed but packages/sdk/dist/index.js does not exist."
    echo "Run: bun run build (from repo root) before using --no-build."
    exit 1
  fi
fi

# ---- bundle ----------------------------------------------------------------
echo "[hermes] Bundling test runner for Hermes (esbuild target=es2019)..."
bun run "$SCRIPT_DIR/bundle-for-hermes.ts"

# ---- run -------------------------------------------------------------------
HERMES_VER=$("$HERMES_BIN" --version 2>&1 | head -1 || echo 'unknown')
echo "[hermes] Executing under Hermes ($HERMES_VER)..."
echo ""
"$HERMES_BIN" "$BUNDLE"
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "[hermes] All tests passed."
else
  echo "[hermes] Tests FAILED (exit code: $EXIT_CODE)"
  exit $EXIT_CODE
fi
