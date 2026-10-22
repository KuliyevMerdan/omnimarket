#!/usr/bin/env bash
# Builds every frontend into one directory for the single-origin deployment (render.yaml):
#   /         standalone PWA (apps/market-react)
#   /shell/   Vue shell (apps/shell-vue), hosting the remote below
#   /remote/  React marketplace as a Module Federation remote
# The API serves it with STATIC_DIR=dist-render and mounts itself under /api (apps/api/src/static.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=dist-render

pnpm --filter @omnimarket/market-react build
MARKET_REMOTE_BASE=/remote/ pnpm --filter @omnimarket/market-react build:remote
# Same origin: the shell finds the remote by path.
SHELL_BASE=/shell/ VITE_MARKET_REMOTE_URL=/remote/remoteEntry.js pnpm --filter @omnimarket/shell-vue exec vite build

rm -rf "$OUT"
cp -R apps/market-react/dist "$OUT"
cp -R apps/market-react/dist-remote "$OUT/remote"
cp -R apps/shell-vue/dist "$OUT/shell"
echo "frontends in $OUT/"
