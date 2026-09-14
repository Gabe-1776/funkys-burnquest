#!/usr/bin/env bash
# Safe positive-allowlist deploy helper for Funky's BurnQuest.
# Positive allowlist: only runtime files and assets are sent. Development
# tools, internal notes, test shots, archives, credentials, node_modules,
# and package metadata remain local.
#
# --delete --delete-excluded removes stale files at the destination that
# are no longer on this allowlist, so a removed asset does not linger on
# the public URL.
#
# Usage:   ./deploy.sh user@host /dest/path
# Example: ./deploy.sh user@example.com /var/www/burnquest/
#
# This script is NOT run automatically. Agents must NOT deploy unless the
# human explicitly asks and provides the host. Never deploy to Mimi's
# production Hostinger site (ksto.world).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST="${1:?usage: ./deploy.sh user@host /dest/path}"
DEST="${2:?usage: ./deploy.sh user@host /dest/path}"

rsync -az --delete --delete-excluded \
  --include='index.html' \
  --include='style.css' \
  --include='three.min.js' \
  --include='manifest.webmanifest' \
  --include='audio.js' \
  --include='sim.js' \
  --include='render2d.js' \
  --include='render3d.js' \
  --include='game.js' \
  --include='glb-dims.js' \
  --include='glb-assets.js' \
  --include='glb-loader.js' \
  --include='wheel-split.js' \
  --include='skeleton-clone.js' \
  --include='char-motion.js' \
  --include='assets/' \
  --include='assets/***' \
  --exclude='*' \
  "${SCRIPT_DIR}/" "${HOST}:${DEST}"

echo "Deployed to ${HOST}:${DEST}"
