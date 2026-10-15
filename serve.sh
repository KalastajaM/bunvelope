#!/bin/bash
cd "$(dirname "$0")"

# Enable job control so each background job below gets its OWN process group.
# Without it they share this script's group, and a terminal-wide stop — Ctrl+Z,
# or a disconnected terminal — suspends the HTTP server along with the script.
# A suspended server is the nastiest failure this setup has: it keeps the port
# bound, so nothing reports an error and `lsof` still shows it listening, but it
# answers no requests. In the browser that is indistinguishable from a stale
# cache, and no amount of hard-reloading fixes it. (If you ever do hit a stopped
# server: `ps -o stat -p <pid>` shows T, and `kill -CONT <pid>` revives it.)
set -m
# Free port 8080 and clear any watcher left running from a previous run that
# didn't shut down cleanly (e.g. the terminal was closed instead of Ctrl+C).
# Self-healing rather than relying on the trap below to always fire.
lsof -ti :8080 | xargs kill -9 2>/dev/null
pkill -f "watch-and-export.mjs" 2>/dev/null

# If the sibling Budget project is present, keep data/app-snapshot fresh
# automatically — no manual `node scripts/export-for-app.mjs` step. Runs the
# export once synchronously so the snapshot exists before the browser can
# hit it, then hands off to a watcher that re-exports whenever budget.json
# changes. Read-only with respect to the ledger; see tasks/local-app.md in
# the Budget project for the full contract.
BUDGET_DIR="../Budget"
WATCHER_PID=""
if [ -f "$BUDGET_DIR/scripts/export-for-app.mjs" ]; then
  echo "Refreshing data/app-snapshot from the live budget..."
  node "$BUDGET_DIR/scripts/export-for-app.mjs" > /dev/null
  EXPORT_CODE=$?
  if [ $EXPORT_CODE -eq 2 ]; then
    : # export-for-app.mjs already explained on stderr why it skipped — app-side changes are kept
  elif [ $EXPORT_CODE -ne 0 ]; then
    echo "warning: initial export failed — data/app-snapshot may be stale or missing" >&2
  fi
  if [ -f "$BUDGET_DIR/scripts/watch-and-export.mjs" ]; then
    node "$BUDGET_DIR/scripts/watch-and-export.mjs" --skip-initial &
    WATCHER_PID=$!
  fi
else
  echo "note: sibling Budget folder not found at $BUDGET_DIR — open data/app-snapshot" >&2
  echo "      manually after running its export-for-app.mjs yourself." >&2
fi

# Run the server as a background job too (rather than exec'd in the
# foreground) so a single trap can reliably tear down both it and the
# watcher, however this script is terminated — Ctrl+C, `kill`, a closed
# terminal — not just on the happy path where a signal reaches the whole
# foreground process group on its own.
# stdin from /dev/null so the server can never earn a SIGTTIN by touching the
# terminal from the background.
node scripts/static-server.mjs 8080 < /dev/null &
HTTP_PID=$!
trap 'kill "$WATCHER_PID" "$HTTP_PID" 2>/dev/null' EXIT INT TERM

# Confirm it actually answers before handing the terminal back. Binding the
# port and serving requests are different things, and the gap between them is
# exactly the failure that reads as a browser-cache problem.
READY=""
for _ in $(seq 1 25); do
  if curl -fsS -m 1 -o /dev/null http://localhost:8080/index.html 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.2
done
if [ -n "$READY" ]; then
  echo "Serving http://localhost:8080 (pid $HTTP_PID) — Ctrl+C to stop"
else
  echo "error: :8080 is bound but not answering (pid $HTTP_PID)." >&2
  echo "       'ps -o stat -p $HTTP_PID' — a T means it was stopped; kill -CONT $HTTP_PID revives it." >&2
fi

wait "$HTTP_PID"
