#!/usr/bin/env bash
# setup-hermes.sh
#
# Downloads the Hermes CLI binary for the current platform.
# Installs to test/hermes/bin/hermes.
#
# Usage:
#   bash test/hermes/setup-hermes.sh
#
# After running, `test/hermes/bin/hermes --version` should print the Hermes version.

set -euo pipefail

HERMES_VERSION="${HERMES_VERSION:-0.13.0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
TMP_DIR="$(mktemp -d)"

mkdir -p "$BIN_DIR"

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="apple" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

ARCHIVE_NAME="hermes-cli-${PLATFORM}.tar.gz"
DOWNLOAD_URL="https://github.com/facebook/hermes/releases/download/v${HERMES_VERSION}/${ARCHIVE_NAME}"

echo "Downloading Hermes v${HERMES_VERSION} for ${PLATFORM}..."
curl -fsSL --retry 3 --retry-delay 2 \
  -o "$TMP_DIR/$ARCHIVE_NAME" \
  "$DOWNLOAD_URL"

echo "Extracting..."
tar -xzf "$TMP_DIR/$ARCHIVE_NAME" -C "$TMP_DIR"

# The archive contains a flat list of binaries. Find the `hermes` executable.
HERMES_BIN="$(find "$TMP_DIR" -name 'hermes' -type f | head -1)"
if [ -z "$HERMES_BIN" ]; then
  echo "ERROR: could not find 'hermes' binary in archive"
  exit 1
fi

cp "$HERMES_BIN" "$BIN_DIR/hermes"
chmod +x "$BIN_DIR/hermes"
rm -rf "$TMP_DIR"

echo "Hermes installed at: $BIN_DIR/hermes"
"$BIN_DIR/hermes" --version

echo ""
echo "WARNING: This Hermes v${HERMES_VERSION} tarball may reject async/await."
echo "         Use it for syntax probes; use a React Native embedded Hermes binary for runtime checks."
echo "         Override via HERMES_VERSION=<newer-ver> if a newer binary is available."
