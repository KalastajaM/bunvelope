# Server migrations

SQL files in this folder are applied in lexical order at server boot by
`server/db.js`. Each filename is recorded in `schema_migrations` after it
succeeds and is never re-run. The whole process is wrapped in a Postgres
advisory lock so concurrent container starts (rolling deploys) serialize
cleanly. Before any pending migration runs, the current `budget_blobs`
rows are copied into `budget_blob_backups` as a cheap rollback point.

`schema_migrations.content_sha256` records a SHA-256 of each applied file.
On every boot the runner re-hashes the on-disk file and compares — a
mismatch (someone edited the file in place) or a missing file logs a loud
warning but never throws. Defence in depth past the CI git-diff check in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

## Rules

1. **Naming**: `NNNN_verb_subject.sql`, monotonically increasing.
2. **Never edit an applied migration.** Once a file has landed on `main`,
   add a new migration instead — CI blocks edits via the "Block edits to
   applied migrations" step in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
3. **One logical change per file.**
4. **Additive within a single release.** Adding nullable columns and new
   tables is safe while the old app version may still be running. To
   drop or rename a column, stage it over two releases:
   - *Release N*: stop reading/writing the column (code change only).
   - *Release N+1*: migration that drops it.
5. **Idempotent DDL where possible**: `create ... if not exists`,
   `alter ... add column if not exists`. The migration runner wraps each
   file in a transaction, so partial failure rolls back.
6. **No auto-committing DDL.** Avoid `CREATE INDEX CONCURRENTLY` — it
   can't run inside the runner's transaction. If you really need it,
   run it out-of-band and document the step here.
7. **Test locally first.** Spin up the docker-compose Postgres
   (`docker compose up -d postgres`), point
   `MIGRATION_TEST_DATABASE_URL` at it, and run
   `npm test -- tests/migrations.test.js`. That test applies every
   migration to an empty DB twice to prove idempotency.
8. **Off-database backups**: run `npm run backup` (daily, see
   `docs/backups.md`). The in-app `budget_blob_backups` table is a
   per-migration snapshot in the same database, and deleting a budget
   cascades to it, so it is not a disaster-recovery substitute.
