#!/usr/bin/env bash
# scripts/dev-local.sh — Boots local cloud-mode Bunvelope (Postgres +
# node server/index.js). Needed for anything the static `python3 -m
# http.server` setup can't serve at all: investments price-fetch, AI,
# auth, or any other /api/* route.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and fill it in." >&2
  echo "Quickest local setup: set BYPASS_GOOGLE=true and BYPASS_PASSWORD=<16+ chars>" >&2
  echo "so you can log in without real Google OAuth." >&2
  exit 1
fi

if ! brew services list 2>/dev/null | grep -q '^postgresql@16 *started'; then
  echo "Starting postgresql@16..."
  brew services start postgresql@16
  sleep 2
fi

BYPASS_PASSWORD=$(grep -E '^BYPASS_PASSWORD=' .env | cut -d= -f2- || true)
if [ -n "${BYPASS_PASSWORD:-}" ]; then
  echo "Login at http://localhost:3000 with password: ${BYPASS_PASSWORD}"
fi

exec node server/index.js
