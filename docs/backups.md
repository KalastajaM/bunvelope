# Backups

## Automatic folder backups (browser and desktop)

In **Settings → Data & Security → Automatic backups**, choose a separate
backup folder. This setting works for both local-folder budgets and the
Express/Postgres app started by `npm run local` (called “cloud mode” in code).
Chrome, Edge or the desktop app is required for the writable folder picker;
other browsers show an explanation instead of hiding the setting.

A Google Drive, Dropbox or OneDrive synced folder works;
Bunvelope writes locally and the sync client handles upload. The destination
cannot be the budget folder, its parent or a subfolder when using local-folder
storage. For Postgres budgets the destination is on the browser’s computer,
not on the database server. Select a dedicated
folder elsewhere, preferably on another disk or synced off-device.

Choosing a folder enables hourly backups and immediately makes the first one.
The app checks every minute while open and when it regains focus. It catches
up when reopened; it cannot back up while closed or while the computer sleeps.
**Back up now** makes an extra snapshot. **Turn off backups** preserves all
existing copies. Settings and folder permissions belong to this browser/desktop
profile and budget, not to the budget JSON. Clearing the profile requires setup
again. Re-select the folder when browser permission expires.

Each `snapshot-…` folder contains the canonical budget JSON files and a
`migration-backup.json` completion manifest with SHA-256 fingerprints, schema
version and capture time. The writer shares the budget save queue and browser
lock, validates the data, and reads the copy back before marking it successful.
Local-folder snapshots refuse missing required files, invalid data and pending
publication recovery. Postgres snapshots read through the authenticated API
after pending saves, validate the returned bundle and use the same verified
folder format. Backup reads never change the active budget’s write version.
The optional legacy templates file can remain absent. A completion manifest is
written last; incomplete copies cannot be restored.

After a successful copy, retention keeps the union of the newest 24 hourly,
30 daily and 12 monthly buckets, using UTC. It only prunes completed automatic
copies belonging to this backup configuration. Migration backups, incomplete
copies, other budgets and folders with extra user content are left alone.
Changing destination leaves the old destination untouched.

The settings show the destination and last verified local copy. Failed or
overdue backups show a status-bar warning linking to these settings. Failures
retry every five minutes; they do not block ordinary saves or advance the last
verified time. If the destination is unavailable, no off-device backup is made
until access returns. Keep the app open until backup writing finishes.

To restore, choose **Select backup…**, select a completed `snapshot-…` or
`backup-v…` folder, then **Restore to empty folder…**. All fingerprints are
checked before writing, and the restored files are read back. The current
budget and backup are preserved. Open the restored folder to use it. A failed
restore is marked incomplete: retry in another empty folder. In Postgres mode,
use **Import folder** in the budget picker to import the restored folder as a
new database budget. Existing data stays untouched.

These folder backups are **not encrypted**, including when the database budget
is encrypted. Enabling them in Postgres mode requires explicit confirmation.
Encrypted budgets must be unlocked for the API snapshot to be decrypted; no
passphrase or encryption key is stored in backup preferences. The copies cover
budget data rather than
arbitrary attachments or app-profile preferences. A successful local copy does
not prove cloud upload. Cloud sync can propagate deletion, and a folder on the
same disk cannot protect against disk failure. Do not edit a budget concurrently
from the CLI or another program: FSAPI cannot acquire an OS-wide filesystem lock.
Automated tests exercise full restore into a fresh budget; this version does not
schedule periodic restore drills on the user’s machine.

## Postgres server backups

`budget_blob_backups` lives in the same Postgres as the budgets, and
deleting a budget cascades to it. It helps undo a bad save or migration; it
does not survive a lost database, a dropped Docker volume, or a delete.
`npm run backup` writes copies outside the database.

## What it does

```bash
npm run backup
```

- Reads every budget in `DATABASE_URL` through the same store as the CLI.
  Read-only: it does not bump `last_opened_at` or write anything.
- Writes one file per budget to
  `$BACKUP_DIR/<budget id>/bunvelope-<name>-<UTC stamp>.json`.
  `BACKUP_DIR` defaults to `~/Bunvelope-backups`. Keep it outside the repo,
  ideally somewhere your machine backup (Time Machine, iCloud Drive, a NAS)
  also copies. Directories are created `0700`, files `0600`.
- Keeps the newest `BACKUP_KEEP` files per budget (default 30) and deletes
  older ones. Other files in those folders are never touched.
- Prints a JSON summary (`ok`, `budgets[]` with file and size, `errors[]`)
  and exits 1 if any budget failed. One failing budget does not stop the
  rest.

The file is the budget bundle (`envelopes`, `budgetItems`, `transactions`,
`accounts`, `envelopeTemplates`, `meta`) plus a `_backup` block with the
budget id, name, version, owner and timestamp.

**Encrypted budgets.** Encryption happens in the browser, so the database
holds ciphertext and the backup copies that ciphertext as-is. It is never
decrypted. The account's encryption salt and verifier are stored in
`_backup.encryption`, because the key cannot be derived from the passphrase
without the salt. You still need the passphrase.

## Run it daily on macOS (launchd)

Not installed automatically. Save this as
`~/Library/LaunchAgents/com.bunvelope.backup.plist`, fixing the two paths
(`which node` gives the node path):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bunvelope.backup</string>
  <key>WorkingDirectory</key><string>/Users/YOU/AI Projects/Bunvelope</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>scripts/backup.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>/Users/YOU/Bunvelope-backups/backup.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Bunvelope-backups/backup.log</string>
</dict>
</plist>
```

The script reads `.env` from the working directory, so `DATABASE_URL`,
`BACKUP_DIR` and `BACKUP_KEEP` come from there. Then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bunvelope.backup.plist
launchctl kickstart gui/$(id -u)/com.bunvelope.backup   # run once now
tail ~/Bunvelope-backups/backup.log                     # expect "ok":true
```

launchd runs a missed job when the Mac wakes, so a laptop asleep at 03:15
still gets its backup. Postgres must be running (brew services or docker).
Otherwise the run logs `connection_failed` and exits 1. Look at the log now
and then: nothing alerts on a failed run.

## Restore

```bash
npm run restore -- --file <backup-file>.json          # dry run: prints the plan
npm run restore -- --file <backup-file>.json --yes    # does it
```

A relative `--file` is resolved against the directory you ran `npm` from,
and `~/` is your home directory.

Without `--yes` nothing is written. The dry run resolves the target, runs
every check the write would, and prints one JSON plan: the target budget
(and its current version for `--into`), the target owner, the backup's
owner (`backup.owner_email`), the collection counts (or `"encrypted"`),
whether the backup is encrypted, and `warnings` (for example unknown
top-level keys in the file, which are ignored). A refusal is one JSON
document with an `error.code` and exit status 1. Blob contents are never
printed.

**As a new budget (default, safest).** The budget is created for the
backup's owner (`_backup.budget.owner_email`) and named
`<name> (restored YYYY-MM-DD)`, so you can compare it with the current
budget before you delete anything. `--owner <email>` restores it for
another user (the plan shows both owners) and `--name <name>` names it.
The per-user budget cap (`MAX_BUDGETS_PER_USER`, default 50) applies.

The budget is created and its collections written in one transaction, so
a failed write (a refusal from the store, a lost database connection)
leaves no new budget behind: fix the cause and run it again.

**Over an existing budget.** `--into <budget-id>` replaces that budget's
collections with the backup's in one write ([`budgets list`](cli.md#protocol-commands-for-scripts)
shows the ids). Only the collections present in the backup are replaced:
one that is missing or `null` in the file keeps the target's current data.
The version is read again on the `--yes` run, so anything edited in the
budget after the dry run is overwritten too. If it changes between that
read and the write, the command refuses with `version_conflict`; run it
again. The replaced data goes to `budget_blob_backups` as with any save,
so a wrong `--into` can be undone from there for a while, but the file
backup is the safer starting point.

`--into` refuses a budget whose owner is not the backup's owner
(`owner_mismatch`, also when the backup names no owner). Add
`--allow-other-owner` when that is what you mean. `--into` takes neither
`--owner` nor `--name`.

```bash
npm run restore -- --file ~/Bunvelope-backups/<id>/bunvelope-family-20260924T031500Z.json
npm run restore -- --file <backup-file>.json --owner me@example.com --name "Family, June" --yes
npm run restore -- --file <backup-file>.json --into <budget-id> --yes
npm run restore -- --file <backup-file>.json --into <budget-id> --allow-other-owner --yes
```

**Encrypted budgets.** The ciphertext is written back as it is: never
decrypted, no passphrase asked. That only works into an account whose
encryption is on with the key the backup was written with (the blobs'
`kid`), normally the account it came from with its encryption settings
unchanged. The rule is the one the server applies to every save, checked
for every blob before anything is written, dry run included:

- a ciphertext blob into an account with encryption off, with a different
  key id, or with no key id at all: `encryption_key_mismatch`;
- a plaintext blob into an account with encryption on:
  `encryption_conflict`. That covers a plaintext backup (use **Import
  file** below, which encrypts as it saves) and a backup that mixes
  ciphertext with plaintext collections, which an incompletely encrypted
  budget produces.

**Error codes.**

| code | meaning |
| --- | --- |
| `bad_arguments` | usage error (missing or empty option, unknown flag, `--into` with `--owner`/`--name`), unreadable `--file`, no owner in the backup and no `--owner`, bad `--name` |
| `not_a_backup` | not JSON, no `_backup` block, or not a `bunvelope-backup` file |
| `unsupported_format_version` | a backup format this version does not read |
| `validation_failed` | a collection fails the store's checks (named in the message) |
| `empty_backup` | the file holds no collections |
| `owner_not_found` | no user with the owner email (new-budget restore) |
| `budget_limit` | the owner is at the budget cap |
| `not_found` | the `--into` budget does not exist, or (rarely) the owner's user row disappeared between the check and creating the new budget |
| `owner_mismatch` | the `--into` budget belongs to someone else; see `--allow-other-owner` |
| `encryption_key_mismatch` | ciphertext that this account's key cannot have written |
| `encryption_conflict` | plaintext into an account with encryption on |
| `version_conflict` | the `--into` budget changed between read and write |
| `connection_failed`, `tls_verification_failed`, `internal_error` | database or unexpected errors |

**From the app.** For a plaintext backup, the app's budget picker also
works: choose **Import file** and pick the backup file. It creates a new
budget and never overwrites one; the `_backup` block is ignored.

## Repeatable restore drill

Run `MIGRATION_TEST_DATABASE_URL=<disposable-postgres-url> npx vitest run
tests/backup-restore-integration.test.js`. This exercises the actual backup and
restore commands against a uniquely named scratch database, verifies plaintext
and encrypted round-trips plus refusal cases, and removes its own database. The
configured test role needs permission to create databases. It does not restore
over an existing budget.


### History storage and portable exports

Schema 8 keeps immutable `.bunvelope-history-<hash>.json` sidecars alongside a
local budget. Cloud mode uses `budget_history_chunks`; baselines and new revision
chunks are committed with the metadata manifest under the same version lock.
Encrypted budgets encrypt each chunk before upload. A missing or altered chunk
refuses loading rather than returning partial history.

Copy the entire live folder, including its sidecars. Settings → Data exports and
automatic backup snapshots embed complete logical history in the ordinary budget
JSON files; they do not depend on the source folder or database. Cloud picker and
Settings exports use DEFLATE ZIP compression where supported, with a valid stored
ZIP fallback. Import accepts those ZIPs, legacy six-file ZIPs, plain JSON bundles,
and ZIPs containing one JSON bundle.

Settings → Data shows logical JSON size before compression, the history share,
and recoverable redundant snapshots. **Compact history** preserves all revisions;
it does not prune transactions or enforce a retention period. Ordinary saves also
perform verified consolidation. Existing migration and automatic backups remain
under their existing retention rules. Immutable chunks referenced by historical
cloud metadata backups are retained; consolidation does not delete those backups.
Successful saves collect unreferenced chunks only after publication, preserving
all chunks needed by the current budget and retained metadata backups.
