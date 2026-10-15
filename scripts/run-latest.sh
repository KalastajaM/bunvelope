#!/usr/bin/env bash
# scripts/run-latest.sh — One command for "run the newest Bunvelope on
# localhost:3000": fast-forward this checkout's `development` to
# origin/development, reinstall dependencies if the lockfile moved, stop
# any Bunvelope server already on the port, then hand over to
# dev-local.sh (Postgres + node server/index.js).
#
# Refuses rather than guesses: a branch other than development, a pull
# that is not a fast-forward, or a non-Bunvelope process on the port all
# stop the script with a message.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

branch=$(git branch --show-current)
if [ "$branch" != "development" ]; then
  echo "This checkout is on '$branch', not 'development'." >&2
  echo "Run this from the main checkout, or switch it to development first." >&2
  exit 1
fi

before=$(git rev-parse HEAD)
echo "Fetching origin..."
git fetch --quiet origin
if ! git merge --ff-only --quiet origin/development; then
  echo "Could not fast-forward to origin/development (local commits, or" >&2
  echo "uncommitted edits in files the update touches). Nothing was changed;" >&2
  echo "sort that out in git, then run this again." >&2
  exit 1
fi
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "Already up to date: $(git log --oneline -1)"
else
  echo "Updated to: $(git log --oneline -1)"
fi

if [ ! -d node_modules ] || ! git diff --quiet "$before" "$after" -- package-lock.json; then
  echo "Dependencies changed, running npm install..."
  npm install
fi

pid=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
if [ -n "$pid" ]; then
  cmd=$(ps -o command= -p "$pid" || true)
  case "$cmd" in
    *server/index.js*)
      echo "Stopping the running server (pid $pid)..."
      kill "$pid"
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$pid" 2>/dev/null; then
        echo "Server pid $pid did not stop; stop it by hand and retry." >&2
        exit 1
      fi
      ;;
    *)
      echo "Port $PORT is in use by something else: $cmd" >&2
      exit 1
      ;;
  esac
fi

echo "Starting. Hard-refresh the browser (Cmd-Shift-R) once it is up."
exec bash scripts/dev-local.sh
