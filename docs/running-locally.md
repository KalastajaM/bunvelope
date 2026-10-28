# Running Bunvelope locally (cloud mode)

Cloud mode is the Express + Postgres server in `server/`, run on your own
machine. There is no hosted deployment: the live budget lives in a local
Postgres, and the server, the headless CLI and the backup script all reach
it through `DATABASE_URL`. (Static/FSAPI mode needs none of this:
`npm run dev:static` serves the app on :8080 against a local folder.)

## 1. Postgres

Either one works; both listen on `localhost:5432`.

**Homebrew** (what `scripts/dev-local.sh` expects):

```bash
brew install postgresql@16
brew services start postgresql@16
createuser bunvelope --pwprompt      # choose a password
createdb bunvelope --owner bunvelope
```

**Docker** (`docker-compose.yml`, user/password/database all `bunvelope`):

```bash
docker compose up -d postgres
```

The data lives in the `pgdata` volume; `docker compose down -v` deletes it.

## 2. `.env`

```bash
cp .env.example .env
```

Set at least:

- `DATABASE_URL=postgres://bunvelope:<password>@localhost:5432/bunvelope`
- `SESSION_SECRET` — `openssl rand -hex 48`
- Login, one of:
  - `BYPASS_GOOGLE=true` and `BYPASS_PASSWORD=<16+ chars>` (shared password,
    no Google setup), or
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
    `OAUTH_CALLBACK_URL=http://localhost:3000/auth/google/callback`, and
    `ALLOWED_EMAILS=<your address>` so nobody else can sign up.
- `NODE_ENV=development` while you use plain `http://localhost` (production
  makes the session cookie HTTPS-only).

Leave `PGSSL` unset. A local host (localhost, 127.0.0.1, ::1, a unix
socket, or no host) gets no TLS; any other host gets TLS with certificate
verification. `sslmode=` in the URL or `PGSSL=disable|verify|no-verify`
override that. Optional keys (`ANTHROPIC_API_KEY`, `BUNVELOPE_SECRETS_KEY`,
`MAX_BUDGETS_PER_USER`, `TRUST_PROXY`, pool sizing, `BACKUP_DIR`,
`BACKUP_KEEP`) are documented in `.env.example`.

## 3. Migrate and start

Budget saves accept up to 64 MiB per request by default. Each save includes
financial history, so even a small edit can send a large request. If a save
returns HTTP 413, set `BUDGET_BODY_LIMIT_MB` in `.env` to a larger positive
integer (for example `128`) and restart the server, then retry the edit.
This raises the authenticated budget request limit without discarding history;
AI and price-fetch limits stay unchanged. Larger limits require more server
memory to parse requests.

```bash
npm install
npm run migrate        # optional: the server also migrates at boot
npm run dev:local      # scripts/dev-local.sh: starts brew postgres, then the server
# or: npm run dev:server  (node --watch server/index.js, Postgres already running)
```

Open http://localhost:3000. `curl localhost:3000/healthz` returns 200 when
the database answers and every migration is applied, 503 otherwise.

To run the newest code day to day from the working repository's checkout, use
`npm run local` (`scripts/run-latest.sh`). It needs the `development` branch, so
it does not work in a clone of the public snapshot, which has only `main`. It
fast-forwards `development` to `origin/development`, runs `npm install` if the
lockfile moved, stops a Bunvelope server already on :3000, then runs `dev:local`. It stops with a
message instead of guessing when the checkout is on another branch, the
pull is not a fast-forward, or something else holds the port. Hard-refresh
the browser afterwards so it drops cached JS.

## 4. CLI and backups

For automatic backups to a folder on your computer, open **Settings → Data &
Security → Automatic backups** in Chrome or Edge. Choose a dedicated folder
(such as one synchronized by Google Drive) and confirm the unencrypted backup
format. This works with the local Postgres setup described here. Backups run
while the app is open; see [backup settings and recovery](backups.md). The
server-side script below remains available for scheduled backups when the
browser is closed and for retaining encrypted database blobs as ciphertext.

```bash
node bin/bunvelope.mjs help
node bin/bunvelope.mjs budgets list --user owner@example.com
node bin/bunvelope.mjs balances --budget BUDGET_UUID --user owner@example.com --lens booked
npm run backup         # every budget → ~/Bunvelope-backups, newest 30 kept
```

Replace the example owner and budget UUID with your own. The CLI needs
`DATABASE_URL` and the migrated database, but no running Express server or
browser session. Without `--user`, database access is not owner-scoped.
`--file budget.json` works on a single bundle without Postgres.

The [CLI usage guide](cli.md) covers bundle export, generated commands and
queries, dry runs, bulk imports, batches and the protocol. Use direct Node
invocation (as above) or `npm run --silent cli --` when piping JSON.
Backups, their daily schedule and the restore path are in [backups.md](backups.md). Run the
backup daily: the in-database `budget_blob_backups` table disappears with
the database and with a deleted budget.

## Database-backed tests

`npm test` skips the suites that need Postgres (migrations, budget store,
headless CLI, auth and budgets routes) unless a test database is set. Point
them at a **throwaway** database, never at the one holding real budgets:
`tests/migrations.test.js` drops every table in the database it is given.

```bash
createdb bunvelope_throwaway            # as your macOS user (Homebrew superuser)
export MIGRATION_TEST_DATABASE_URL="postgres://$USER@localhost:5432/bunvelope_throwaway"
export ROUTES_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL"
npm test                                # now nothing is skipped
```

The app's own database user usually cannot create databases, which some
suites do for scratch copies; the Homebrew superuser can. The same database
works for a real `npm run backup` / `npm run restore` rehearsal: set
`DATABASE_URL` to it for those commands only.

## Errors and logs

There is no external error tracker or alerting, deliberately: nothing is
hosted, so there is nothing to page anyone about. The server logs every
request and error as JSON lines (pino) on stdout/stderr, with cookies,
auth headers and request bodies redacted. Run it in a terminal you can see,
or, when it runs under launchd or docker, read its log file or
`docker compose logs`. Failed saves also surface in the app itself.

## Self-hosting with Docker

`Dockerfile` builds a production image (Node 24 alpine, pinned by digest;
the refresh command is in the file) that runs `node server/index.js` as the
unprivileged `node` user on port 3000. It sets `NODE_ENV=production`, so the
session cookie is Secure: put it behind a TLS-terminating reverse proxy, set
`TRUST_PROXY=1`, and give it the same `.env` keys as above. Point
`/healthz` at your supervisor's health check.

## Troubleshooting

- **`connection_failed` from the CLI** — Postgres is not running or
  `DATABASE_URL` points elsewhere. `brew services list` /
  `docker compose ps`.
- **`tls_verification_failed`** — a remote database's certificate did not
  verify. Install its CA, or set `PGSSL=no-verify` knowingly.
- **"The server does not support SSL connections"** — `PGSSL=verify` or
  `sslmode=require` is set against a local Postgres without TLS. Remove it.
- **OAuth redirect mismatch** — the Google client's authorized redirect must
  equal `OAUTH_CALLBACK_URL` exactly.
- **Session cookie not set** — `NODE_ENV=production` over plain HTTP, or a
  proxy in front without `TRUST_PROXY`.
- **`/api/ai/*` returns 503 `ai_disabled`** — `ANTHROPIC_API_KEY` is unset.
- **Forgot the rotated bypass password** — clear the stored hash so
  `BYPASS_PASSWORD` is compared again:
  `update users set bypass_password_hash = null where google_sub = 'bypass:local';`

## Files to read first if something's off

- `server/index.js` — CSP, mode-script injection, route mounts, boot.
- `server/db.js` — pool, the TLS rule (`buildSslConfig`), advisory-locked
  migration runner, health check.
- `server/auth.js` — Google OAuth, bypass-password mode, sessions,
  `ALLOWED_EMAILS`.
- `server/services/budget-store.js` — budget reads/writes shared by the
  routes, the CLI and the backup script.
- `js/storage/api-adapter.js` and `js/storage/crypto.js` — the client side
  of cloud mode, including per-user encryption.
