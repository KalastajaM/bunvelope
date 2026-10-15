# CLI usage

## Preview envelope funding

`envelope funding` suggests same-day transfers from other envelopes with spare
money above their reserve and savings target. The calls below are read-only:

```bash
node bin/bunvelope.mjs envelope funding --file budget.json --envelope Groceries --now 2026-10-07
node bin/bunvelope.mjs envelope funding --file budget.json --envelope Groceries --source Leisure --now 2026-10-07
node bin/bunvelope.mjs envelope funding --file budget.json --envelope Groceries --sources '["Leisure","Travel"]' --now 2026-10-07
```

Without `--source` or `--sources`, the result contains `gap` and `candidates`. Selecting one or more sources
returns `preview`: before/after spare for affected envelopes, savings goals,
`remainingGap`, `blockers`, `canApply` and proposed `transaction.record` steps.
Candidates include `available` (eligible spare) and `amount` (the single-source suggestion).
Use either `source` or a nonempty, distinct `sources` array. Combined funding is
split proportionally to eligible spare, rounded to cents, and capped at the gap.
The preview lists `sources` with their contributions and `total` funding. Every active envelope is projected again, including automatic refill
chains. Any new or worse daily reserve deficit or goal shortfall blocks the
recommendation. Outside-window goals cannot supply money; an indirect reduction
in such a goal also blocks the preview. Monthly resets can erase the benefit,
in which case no transfer is recommended. A partial improvement is labelled.

Only an applicable preview returns steps. The browser rechecks the preview and
uses `envelope fund` through the session after **Apply funding**, with Undo available.
That command accepts `envelope`, either `source` or `sources`, and `expected` (the exact
`JSON.stringify` of the reviewed query value). It repeats the assessment when
its turn in the write queue arrives and rejects a changed date, amount or
forecast with `funding_preview_changed`. Normal commit checks and policies apply. The
query never writes. Envelope transfers do not change cash-account balances or
fix cash-account deficits. All selected transfers save atomically and Undo reverses the whole group. Refresh the suggestions
before considering another.

## Review what needs attention

`overview attention` is read-only. It returns twelve months of projected cash
shortfalls, envelope reserve gaps and savings goal gaps, ordered by the first
relevant date (cash first on ties). It uses the same daily forecasts as the
purchase checker, independent of the selected balance lens.

```bash
node bin/bunvelope.mjs overview attention --file budget.json --now 2026-10-07
node bin/bunvelope.mjs overview attention --file budget.json --date 2026-11-01 --now 2026-10-07
```

`items` identify the affected account or envelope with a stable `key`, `kind`,
`id`, `name` and `date`. Envelope gaps distinguish the first reserve breach
from the largest gap and low date. Savings goals use their deadline; overdue
goals are checked against today's projected balance, and undated goals use the
forecast end. `incomplete` lists goals beyond the window, unavailable envelope
forecasts and cards without a configured repayment account. An empty `items`
array is only a complete clear result when `incomplete` is also empty. As with
all forecasts, unrecorded costs and credit limits are not assessed.

## Check a purchase

`purchase preview` is read-only and uses the same plan netting, envelope
projections and cash simulation as the app. Dates must be today or later within
the 12-month envelope forecast window. Names resolve through the core schema.

```bash
node bin/bunvelope.mjs purchase preview --file budget.json --amount 250 --date 2026-10-15 --account Checking --envelope Groceries --now 2026-10-07
node bin/bunvelope.mjs purchase preview --file budget.json --amount 250 --date 2026-10-15 --account Checking --envelope Groceries --funding-envelope Leisure --funding-amount 100 --now 2026-10-07
```

The answer includes `envelope`, `otherEnvelopes`, `accounts`, `goals`, `funding`,
`suggestions` and `steps`. Other envelopes report shortfalls created or worsened
by automatic refills. Account checks use daily lows and identify new, worsened or existing
shortfalls. Each account also returns `current` (posted entries through today),
`changeToLow`, `movements` (income, spending, transfers, repayments and other
adjustments through the after-purchase low), and `lowDifference`. The current
balance plus those movements reconciles to `after.low.balance`; a projected
negative balance is not a statement about today's balance. `assessment` separates
purchase problems (`attention`), missing information (`incomplete`), unchanged
existing gaps (`existing`) and a clear forecast (`covered`). The original `status`
still reports the overall forecast, including existing gaps.
Goal dates outside the forecast window and cards without configured
repayment accounts (or repayments beyond the window) are unassessed; `covered` means covered within this forecast,
not an assessment of unrecorded commitments or credit limits. Suggestions are
optional candidate moves, not applied changes. Query again with a candidate to
see its actual effect. Only explicitly dispatching the returned `steps` records
the transfer and purchase; the browser does this atomically after a separate
Record/Schedule action. Future-dated rows remain scheduled.

## Explain number changes

Financial history is automatically committed with every successful app or CLI
edit, including added, edited and deleted transactions, accounts, envelopes,
plans, templates, investment data and financial settings. Queries and dry runs
never create history. The browser also initializes history automatically when
you first open **Why did this number change?**. No manual Save step is needed.

```bash
node bin/bunvelope.mjs comparison explain --file budget.json --date 2026-10-07 --metric netWorth --lens booked --now 2026-10-08
node bin/bunvelope.mjs comparison explain --file budget.json --date 2026-10-07 --metric forecast --now 2026-10-08
node bin/bunvelope.mjs comparison explain --file budget.json --date 2026-10-07 --metric spare --envelope food --now 2026-10-08
node bin/bunvelope.mjs comparison explain --file budget.json --date 2026-10-07 --metric unrealized --now 2026-10-08
```

A selected date means the **start of that calendar day**, using the records
that existed then. On the first recorded day it means the first capture, not
midnight (`partialDay: true`). A payment entered today but dated last month is
an addition today. Both endpoints use the selected balance lens and current
calculation rules; elapsed forecast time is explained separately.

`explain` returns `ready` with amounts and ordered group deltas, or `unavailable`
when history does not cover the date, the currency changed, or the metric was
absent at either endpoint. `coverage.start` identifies the continuous history
start. Detected external edits start a new continuous segment; earlier captured
segments remain usable, while dates in a gap are unavailable. History does not
reconstruct unrecorded changes before this feature was enabled. It is stored
with the budget and included in exports, including records later deleted.
Each group's `sources` identifies added, edited or removed records. Sources now
include `details` (scalar field paths, before/after values and display formats)
and an optional `amount` (label and before/after record amounts). Reference fields
use names from their respective historical/current snapshots. Transaction amounts
are signed for income, expenses and adjustments; transfers show magnitudes.
These record amounts are context, not per-record contributions to the group's
delta. Settings and investment changes also include source field details.
`storage size` reports logical JSON bytes for budget data and history, revision
counts, and space recoverable from verified redundant snapshots. These are not
filesystem or database allocation figures. `history compact` joins only adjacent
segments whose boundary is proven by replay; it preserves every revision, real
data gaps, clock reversals, and previously uncovered calendar days. Normal saves
also consolidate safe redundant segments automatically.

```bash
node bin/bunvelope.mjs storage size --file /tmp/budget.json
node bin/bunvelope.mjs history compact --file /tmp/budget.json --dry-run
node bin/bunvelope.mjs history compact --file /tmp/budget.json
```

Schema 8 stores folder/cloud history as immutable baseline and revision chunks.
Browser saves send only new chunks plus their manifest; PostgreSQL publishes them
atomically with the budget version. Encrypted chunks use the same data key as the
budget. Exports, CLI JSON bundles and automatic backups are self-contained and
retain the logical history format. Older builds refuse schema 8; use the verified
pre-migration backup if an older build must be restored. Do not copy only the six
JSON files from a live schema-8 folder: copy the whole folder or use Export.

There is no automatic 1,000-entry truncation of this new history. The changelog
shows the latest 200 saves; this display limit does not remove older revisions.

Effects add up in the reported order; interacting changes are not independent.
Each group's sources list identifies up to 100 records whose endpoint values
changed, with `count` reporting the full number. Individual intervening edits
(including changes later undone) remain in the automatic changelog. `spare`
takes a literal envelope id; the other metrics cover the budget. Forecast is
Overview's twelfth monthly point, independent of the balance lens.

Legacy `comparison save` / `comparison clear` remain available for compatibility.
An existing saved point can be used on its exact date even when automatic
history does not cover it; it does not prove coverage of surrounding dates.
Clearing that legacy point does not delete automatic history. Without `--date`,
`explain` uses the continuous history start, or the legacy point if history has
not started.

## Introduction

The CLI uses the same core commands, queries and commit checks as the browser.
It can work directly with Postgres or a single JSON bundle without running
Express. Run it from the repository root with Node.js 20+ after `npm install`.
There is no separate build or published package to install.

- [Setup and budget selection](#choose-a-budget)
- [Calling from another project](#calling-from-another-project)
- [Flags, JSON and references](#flags-json-input-and-references)
- [Dry runs and policies](#preview-commit-and-policies)
- [Write commands](#write-command-families)
- [Bulk transactions](#bulk-transaction-tools) and [atomic batches](#atomic-batches)
- [Queries and reports](#queries-and-reports)
- [Protocol commands](#protocol-commands-for-scripts)
- [Output and errors](#output-exit-codes-and-troubleshooting)

## Find a command

```bash
node bin/bunvelope.mjs help
node bin/bunvelope.mjs help transaction record
node bin/bunvelope.mjs help reports spending
node bin/bunvelope.mjs help batch
```

`npm run cli -- ...` is the interactive shorthand. For scripts and pipes, use
`node bin/bunvelope.mjs ...` or `npm run --silent cli -- ...` so npm's banner
is not mixed into the result. Help is plain text; operations return JSON.
Use `help COMMAND`, rather than assuming `COMMAND --help` is supported.

The public command list and flags come from [the core registry](../js/core/index.js)
and its input schemas. Command names become space-separated, kebab-cased verbs:
`transaction.setFields` becomes `transaction set-fields`, `netWorth.current`
becomes `net-worth current`, and `ageOfMoney` becomes `age-of-money`.
Internal maintenance commands are omitted from the public help list.
Help lists top-level flags; nested JSON shapes and defaults live in the
registry schemas (see the schema export below). Protocol-command options are
listed in [Protocol commands for scripts](#protocol-commands-for-scripts);
`help budget read` does not describe them.
An unknown help target prints `Unknown command` with exit 0; use the public
registry list to check availability programmatically.

## Choose a budget

### Postgres

Set `DATABASE_URL` in the environment or the repository's `.env`. The CLI uses
the server's TLS configuration: local connections need no `PGSSL` setting;
remote connections verify certificates by default. See [running locally](running-locally.md)
for database setup and migrations. The CLI does not run migrations or require
an HTTP server, browser login, OAuth credentials or `SESSION_SECRET`.

```bash
node bin/bunvelope.mjs budgets list --user owner@example.com
node bin/bunvelope.mjs budget probe --id BUDGET_UUID --user owner@example.com
node bin/bunvelope.mjs balances --budget BUDGET_UUID --user owner@example.com --lens booked
```

Replace `BUDGET_UUID` with an ID returned by `budgets list`; budget names are
not accepted as selectors. `--user` accepts an email (case-insensitive) or user
UUID and restricts operations to budgets owned by that user. Without it,
`budgets list` lists every owner's budgets, including `owner_email`, and other
operations are not owner-scoped. This is a trusted database administration
interface, not a remote authenticated API. `--user` is a scope filter, not login.

Core commands and queries require exactly one of `--budget` or `--file`.
The four protocol commands (`budgets list`, `budget probe`, `budget read`,
`budget apply`) use their own options, documented below; budget operations
there use `--id`, not `--budget`.

### Local bundle (no database)

`--file` reads a **single bundle object**, not an FSAPI directory, a ZIP export,
or the entire response from `budget read`. To take a database snapshot (these
examples use `jq`):

```bash
node bin/bunvelope.mjs budget read --id BUDGET_UUID --user owner@example.com > budget-read.json
jq '.bundle' budget-read.json > budget.json
node bin/bunvelope.mjs balances --file budget.json --lens booked
```

The bundle uses these keys: `accounts`, `envelopes`, `transactions`,
`budgetItems`, `envelopeTemplates`, and `meta`. Its `meta.schemaVersion` must
match the current application schema (currently 8). A minimal scratch bundle
for trying the examples is:

```json
{
  "accounts": [],
  "envelopes": [],
  "transactions": [],
  "budgetItems": [],
  "envelopeTemplates": [],
  "meta": { "schemaVersion": 8, "currency": "EUR", "country": "FI" }
}
```

Save that as `budget.json`, then create the records used by the basic examples:

```bash
node bin/bunvelope.mjs account create --file budget.json --name Checking --type bank --initial-balance 1000
node bin/bunvelope.mjs account create --file budget.json --name Amex --type credit_card
node bin/bunvelope.mjs envelope create --file budget.json --name Groceries --category Food
node bin/bunvelope.mjs envelope create --file budget.json --name Fun --category Leisure
node bin/bunvelope.mjs envelope create --file budget.json --name Rent --category Home
```

Successful writes replace the bundle via a temporary file and rename. File
mode has no database version check: use one writer per file. It changes only
that file, not the source database. Do not pass `--user` in file mode; it is a
database owner lookup, not file access control.

Both data sources reject encrypted collections (`encrypted_budget`) and
unsupported schemas (`unsupported_schema`). `budget probe` can inspect metadata
without decrypting or requiring a readable schema. Open an older budget in the
current app to migrate it; changing the schema number by hand is not a migration.

The CLI does not open or write a browser budget folder, import CSV/ZIP files,
create database budgets/users, fetch market prices, or run the browser's
load-time maintenance automatically. Start with a budget created in the app
or the scratch bundle above. Run `month start` explicitly when you want due
posting and rollover. There is no CLI undo or `queryAfter` verb; a dry run
previews a command's diff, not an arbitrary query after that command.

## Calling from another project

Use a pinned Bunvelope checkout with its dependencies installed (`npm ci` for
a repeatable install from the lockfile). `protocol_version: 1` identifies the
JSON envelope, and `meta.schemaVersion` identifies the budget data format;
neither pins command availability or every query's result fields. Record the
checkout's Git commit and check its help when upgrading. There is no CLI
`--version` option or separately published SDK.

Call the entry point by absolute path and pass each argument separately. For
example, in another Node.js project (replace both paths):

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { stdout } = await run(process.execPath, [
  '/path/to/Bunvelope/bin/bunvelope.mjs',
  'balances', '--file', '/path/to/project/budget.json', '--lens', 'booked',
  '--now', '2026-10-01T12:00:00Z',
], { env: { ...process.env, TZ: 'UTC' }, maxBuffer: 32 * 1024 * 1024 });
const result = JSON.parse(stdout);
if (result.protocol_version !== 1) throw new Error('Unsupported CLI protocol');
console.log(result.value);
```

`execFile` rejects on a nonzero exit; inspect its `code` and `stderr` using
the [error contract](#output-exit-codes-and-troubleshooting). Size the output
buffer for the budget, especially for full reads, imports and diffs. Avoid
building a shell command from record names or JSON.

Relative `--file` and `--input` paths, and the default `.env` lookup, use the
**process working directory**, not the entry point's directory. Supply
database settings in the child environment, set its `cwd` to the checkout,
or set `DOTENV_CONFIG_PATH` to an explicit `.env` path. Already-set environment
variables take precedence over `.env`. File mode needs no database settings.

For nested input shapes, export the public schemas from the checkout root:

```bash
node --input-type=module <<'JS'
import { registry } from './js/core/index.js';
import { toJsonSchema } from './js/core/schema.js';
console.log(JSON.stringify(registry.list().map(({ name, kind, summary, input }) => ({
  name, kind, summary, input_schema: toJsonSchema(input),
})), null, 2));
JS
```

These schemas describe inputs, not output schemas or all business rules.
The CLI resolves reference names before calling core; callers importing the
[Node session](../server/session/node-session.js) directly must supply IDs
(or query `ref.resolve` first). Prefer the subprocess interface unless you
intend to depend on checkout-internal JavaScript APIs.

## Flags, JSON input and references

- Use separate arguments: `--amount 12.30`, not `--amount=12.30`. Quote names
  containing spaces and JSON values. Examples use POSIX shell quoting.
- Camel-case schema fields become kebab-case flags: `--from-account`,
  `--include-archived`, `--group-by`. Existing snake-case fields stay that way:
  plan items use `--default_amount`, `--envelope_id`, `--start_month`.
- Boolean fields accept a bare flag, `true`, or `false`: `--cleared`,
  `--cleared true`, `--cleared false`. The global `--dry-run` takes **no value**.
- Money uses decimal units of the budget currency, without a currency symbol.
  Transaction amounts are positive magnitudes; the type supplies the direction.
  `balance adjust` takes a signed correction. Dates use `YYYY-MM-DD`, months
  use `YYYY-MM`. A command's `--date` is not a global clock override; the
  global `--now` is. `--now 2026-11-01` (local midnight) or an ISO date-time
  (`--now 2026-11-01T08:30:00Z`) fixes the session clock for the whole run:
  "today", lens calculations and write/audit timestamps use that clock.
  Command-specific dates still follow their own rules (for example, a reversal
  defaults to the original row's date). Use it to re-run a comparison or preview.
- Objects and arrays are JSON: `--fields '{"favorite":true}'` or
  `--ids '["TRANSACTION_ID"]'`. Nullable fields accept the literal `null`.
- `--input input.json` supplies the complete command/query input object and
  cannot be combined with command-specific flags. Global source, owner, policy,
  clock and dry-run flags can still be used. There is no stdin (`--input -`) shortcut.
  JSON keys retain schema spelling, such as `fromAccount` or `default_amount`.

Calendar dates use the Node process's timezone. For repeatable comparisons,
set `TZ` as well as `--now`, for example
`TZ=Europe/Helsinki node bin/bunvelope.mjs balances --file budget.json --lens today --now 2026-10-01`.
An ISO timestamp with `Z` or an offset fixes an instant, but its local calendar
day still depends on `TZ`; a timestamp without an offset is local time.
`--now` changes the calculation clock and write timestamps, not the data:
it does not restore an older snapshot, reprice holdings historically, or filter
all booked rows. Use the appropriate query's date/range options as well.

Fields typed as `ref` accept an exact ID or a case-insensitive name
among non-archived records. Plan items match their description. Ambiguous names
return candidates; archived records must be selected by ID. Transaction IDs
are literal IDs, never payee names. You can also look up IDs explicitly:

```bash
node bin/bunvelope.mjs ref resolve --file budget.json --kind account --name Checking
node bin/bunvelope.mjs ref resolve --file budget.json --kind envelope --name Groceries
node bin/bunvelope.mjs ref resolve --file budget.json --kind budgetItem --name Rent
```

Schema-declared references are resolved inside `--fields`, `--rows`, `--lines`,
`--splits` and each batch step too. Ordinary string fields (such as transaction
IDs, adjustment `targetId` and override `id` fields) still require IDs; only
fields typed as `ref` resolve names. All uppercase ID tokens in this guide
are placeholders to replace with actual IDs.

## Preview, commit and policies

```bash
node bin/bunvelope.mjs transaction record --file budget.json --type expense --amount 12.30 --account Checking --envelope Groceries --dry-run
node bin/bunvelope.mjs transaction record --file budget.json --type expense --amount 12.30 --account Checking --envelope Groceries
```

`--dry-run` performs validation and policy checks and reports the proposed diff,
but writes nothing. Remove it to commit. A preview does not reserve its IDs or
version: the real command computes again against current data. Queries never
write and do not need `--dry-run`.

Postgres commands read a version and commit atomically against it. On a version
conflict, the Node session reloads and recomputes once; a second conflict fails.
A no-op returns `committed: false`. Commands also append change-log entries when
applicable. Reads do not update the budget's last-opened timestamp.

`--policy strict-ledger` enables the ledger policy for a command or batch.
Policies stored in `meta.policies` always apply; flags can add to that floor,
not remove it. A comma-separated list is accepted; `strict-ledger` is currently
the only registered policy. It blocks future posted rows, newly stored or
changed set-mode fill lines, and edits/deletions of posted past rows (except
bookkeeping marks and rows created today). Prefer reversals or corrections
when preserving history.
`--force` is a command-specific input, only available where help lists it;
it can bypass history/future-date rules and some command-specific guards, but
cannot bypass all validation or the set-line prohibition. Bypassed policy
rules appear in `forced`.
Template set targets are resolved to add-mode deltas before policy checks,
so those fills are allowed under `strict-ledger`. Explicit manual set lines
are refused by `allocation fill` even without a policy.

Closed months are a separate browser confirmation mechanism, not a core write
lock. `month close`, `reopen` and `clear-reopen` update that metadata; CLI
writes do not prompt for it. `strict-ledger` enforces its own history rules
independently of whether a month is closed.
Only a month that has ended can be closed: `month close` refuses the current
month and later ones with `month_not_ended` (the session clock decides, so
`--now 2026-10-05` refuses `--month 2026-10` and accepts `2026-09`).
Reopening requires a currently closed month; `month clear-reopen` drops an
automatic-close exception, rather than manually closing a month.

## Write command families

Examples below are independent recipes, not a script to run from top to bottom.
Inspect returned `value` fields for newly created IDs and replace placeholders
before running later operations. `help` provides the complete flags for each verb.

| Area | Verbs |
| --- | --- |
| Transactions | `transaction record`, `amend`, `delete`, `clear`, `post`, `reverse`, `flag`, `set-fields`, `merge-transfer`, `import`, `resolve-duplicates` |
| Balance corrections | `balance adjust`, `balance set`, `account reconcile` |
| Accounts | `account create`, `update`, `reorder`, `archive`, `delete` |
| Envelopes | `envelope create`, `update`, `reorder`, `archive`, `delete`, `move` |
| Plan items | `budget-item create`, `update`, `delete`, `skip-occurrence`, `unskip-occurrence`, `top-up` |
| Templates and allocation | `template create`, `update`, `delete`; `allocation fill`, `consolidate` |
| Monthly maintenance | `month post-due`, `rollover`, `start`, `close`, `reopen`, `clear-reopen` |
| Settings and payees | `settings update`; `payee merge`, `alias`, `unalias`, `hide`, `unhide` |
| Scenario expenses | `stress-expense set`, `stress-expense delete` |
| Investments | `investment set-price`, `set-holding`, `remove-holding`, `add-manual-row`, `update-manual-row`, `remove-manual-row`, `set-payee-rule`, `tag-symbol`, `rename-symbol` |

Within each family, repeat the prefix: for example, `amend` in the transaction
row means `transaction amend`.

## Transactions and balance corrections

`transaction record` requires `--type` and a positive `--amount`. Type values
use underscores, even though flag names use hyphens:

| Type | Other required inputs and common options |
| --- | --- |
| `expense` | `--account`; optional `--envelope`, `--budget-item` or `--splits` |
| `income` | `--account`; optional `--envelope`, `--interest-of` (a loan given the income is interest on) |
| `account_transfer` | Distinct `--from-account` and `--to-account` |
| `envelope_transfer` | Distinct `--from-envelope` and `--to-envelope`; omitted or `null` means Unallocated |
| `investment_transfer` | Distinct `--from-account` and `--to-account`, `--direction buy\|sell\|dividend`; sells also need positive `--units`; optional `--symbol`, `--fee`, `--price-per-unit` |
| `debt_payment` | Distinct `--from-account` and `--to-account`; optional `--envelope` |

Inputs unrelated to the chosen type are rejected. For expenses, `--envelope
null` means unassigned; `--envelope __none__` deliberately selects no envelope.
An expense split needs at least two lines that sum to the amount:

```bash
node bin/bunvelope.mjs transaction record --file budget.json --type expense --amount 30 --account Checking --splits '[{"envelope":"Groceries","amount":20},{"envelope":"Fun","amount":10}]' --dry-run
node bin/bunvelope.mjs transaction record --file budget.json --type income --amount 2500 --account Checking --payee Employer --cleared
node bin/bunvelope.mjs transaction record --file budget.json --type income --amount 25 --account Checking --payee Sam --interest-of "Loan to Sam"
node bin/bunvelope.mjs transaction record --file budget.json --type expense --amount 20 --account Checking --envelope Groceries --date 2026-11-15 --scheduled
node bin/bunvelope.mjs transaction post --file budget.json --id SCHEDULED_TRANSACTION_ID
```

Ordinary recorded rows count as posted unless `--scheduled` is set, but are
not cleared unless `--cleared` is given. `transaction post` accepts a stored
scheduled row ID and clears it by default (`--cleared false` leaves it
uncleared). One-off scheduled rows are not posted by `month post-due` or
`month start`; post them explicitly. Forecast preview IDs are not stored rows;
to settle a plan occurrence by hand, record a transaction with
`--from-budget PLAN_ITEM_ID:2026-10` using the actual item ID and month.
`transaction import` uses these same input fields, rather than stored-row
keys such as `from_account` and `envelope_id`.

```bash
node bin/bunvelope.mjs transaction record --file budget.json --type expense --amount 12.30 --account Amex --envelope Groceries
node bin/bunvelope.mjs transaction reverse --file budget.json --id TRANSACTION_ID --dry-run
node bin/bunvelope.mjs transaction delete --file budget.json --ids '["TRANSACTION_ID"]'   # array flags take JSON
node bin/bunvelope.mjs balance set --file budget.json --envelope Groceries --balance 250 --note "count"
node bin/bunvelope.mjs account reconcile --file budget.json --account Amex --balance -1043.20
```

The balance commands are `balance adjust|set` and `account reconcile`;
`adjustment` and `fill` are not `transaction record` types. Both balance
commands require a note and one account or envelope. `balance set` measures
the booked balance, including scheduled rows. Reconciliation uses cleared
rows through today by default; pass `--clear '[]' --date YYYY-MM-DD` to use
cleared rows through a particular reconciliation date, or list the transaction
IDs to clear in that same command. It refuses undated account transactions
(`reconcile_undated`) even when forced. Date those rows first.

A reversal appends mirror rows and marks the original `reversed_by`; it never
edits the amount. Its default date is the original date; use `--date` for a
different correction date. Split expenses, legacy set-mode fills, investment
dividends/adjustments and scheduled rows cannot be reversed. `--dry-run`
reports the diff and writes nothing.

Adjustment targets can be changed with `transaction amend --file budget.json
--id TX_ID --target envelope --target-id ENVELOPE_ID` (or `--target account`).
The target ID must exist in the selected collection and is a literal ID, not
a name. Omit both target flags to retain the stored target.

In the browser, open a stored transaction and choose **Reverse transaction**.
The preview is a dry run of the same command, showing the correction date and
mirror rows with their account/envelope effects. The default date is the original
transaction's date; changing it requires another preview. Confirm to append the
correction. Original and reversal records link to each other. Unsupported rows
and policy failures are explained without a force option; closed months retain
the browser's explicit confirmation. A reversal is a durable correction, not a
generic Undo action.

## Accounts and envelopes

New accounts and envelopes automatically receive a unique four-character short
code. Supply `--code SA01` on creation or `--fields '{"code":"SA02"}'` on
update to choose your own. Codes use A–Z and 0–9, are normalized to uppercase,
and cannot duplicate any account or envelope code, including archived entries.
A blank code generates one; an omitted code on update preserves the current
value. Saving a legacy entry without a code in the editor assigns one.


```bash
node bin/bunvelope.mjs account create --file budget.json --name Savings --type savings
node bin/bunvelope.mjs account update --file budget.json --id Savings --fields '{"favorite":true}'   # object and array flags take JSON
node bin/bunvelope.mjs account update --file budget.json --id Mastercard --fields '{"settledFrom":"Checking"}'
node bin/bunvelope.mjs account reorder --file budget.json --ids '["ACCOUNT_ID_1","ACCOUNT_ID_2","ACCOUNT_ID_3"]'
node bin/bunvelope.mjs envelope create --file budget.json --name Fuel --category Car
node bin/bunvelope.mjs envelope archive --file budget.json --id ENVELOPE_ID --archived true
```

Savings accounts support `interestTierMode`: `progressive` (the default) applies
each rate only to its portion of the balance; `full-balance` applies the matching
tier's rate to the entire balance (for example, Danske). `upTo` is exclusive:
with a limit of 10000, a balance of exactly 10000 uses the next tier in
full-balance mode. Omit `upTo` on the final tier to cover the rest.

```bash
node bin/bunvelope.mjs account update --file budget.json --id Savings --fields '{"interestTierMode":"full-balance","interestTiers":[{"upTo":10000,"rate":1},{"rate":2}]}'
```

This setting feeds account interest estimates and forecasts. Existing accounts
without a mode keep progressive calculation; set `interestTierMode` to `null`
to restore that default.

Names are unique per kind, case-insensitively and archived entries included.
`account update` takes its changes as one JSON `--fields` object (there are no
per-field flags; `null` clears a nullable field). A type change across the
budget's cash boundary (to or from an investment, asset or loan type) also needs
`--move-envelope <id|null>`. A loan's `initialBalance` is the amount owed, so
it is negative (`--initial-balance -150000`); a positive one is refused with
`bad_input`. `account delete` and `envelope delete` are refused
with `in_use` (and the counts) while anything still references the entry;
archive it instead. The system command that archives legacy `(deleted: …)`
envelopes is run by the app on load and is not listed by `help`.

`settledFrom` (credit cards, and bank or cash accounts used as a card) names
the account that pays the card off in the forecast: the Forecast lens, `forecast
balances`, `forecast simulation` and `net-worth projection` pay what the card
owes at each month-end on the following 15th from that account, so the card
holds about one month of spending and the paying account carries the rest. A
month with a transfer or debt payment into the card already dated is skipped
(you paid it). `null` clears it; the paying account must be another live bank,
cash or savings account. A settled account is not flagged below zero in `forecast
simulation`'s alerts (its paying account is watched instead). Deleting the paying account clears the setting on its cards.

`account reorder` and `envelope reorder` require every ID exactly once,
including archived records, in the desired order.

## Settings, closed months, payees and investments

```bash
node bin/bunvelope.mjs settings update --file budget.json --fields '{"country":"SE"}'
node bin/bunvelope.mjs month close --file budget.json --month 2026-09
node bin/bunvelope.mjs month reopen --file budget.json --month 2026-09
node bin/bunvelope.mjs payee merge --file budget.json --from '["shell oy"]' --from-names '["Shell Oy"]' --to Shell
node bin/bunvelope.mjs investment set-price --file budget.json --symbol ABC --price 12.5
node bin/bunvelope.mjs investment rename-symbol --file budget.json --from ABC --to ABD
```

`settings update --fields` accepts `currency`, `locale`, `country`,
`emergency_envelope_id`, `emergency_duration_months`, `emergency_credit_source`
and `auto_close_after_months`. It does not change the budget name, UI preferences
or saved what-if scenarios. `null` clears nullable fields; `country: null`
resets to FI. The [schema export](#calling-from-another-project) lists accepted
currency/country codes and nested fields for all commands.

`payee merge` rewrites matching historical payees and remembers aliases;
`--from` contains normalized keys (trimmed, lowercase), and the required
`--from-names` array supplies original spellings to remember. `payee alias` only
affects new rows. Hiding a payee changes suggestions, not historical rows.

`investment set-holding` sets standalone positions. `--cost-basis` is the total
paid for the whole holding, never a per-unit purchase price (a ring bought for
€100 has total cost 100). Set `--valuation-only true` to track an item's current
value without tracking cost or gains, for example an inherited item with an
unknown original cost (`--cost-basis 0`). Such holdings keep contributing to
portfolio value, but are excluded from cost/gain totals and the investment tax
report and do not show the zero-cost warning. This is an explicit reporting
choice, not a determination of tax liability. The flag is per account and symbol;
omitting it when replacing the holding restores normal cost tracking.

```bash
node bin/bunvelope.mjs investment set-holding --file budget.json --account INVESTMENT_ACCOUNT_ID --symbol NECKLACE --units 1 --cost-basis 0 --valuation-only true --name 'Inherited necklace' --dry-run
```

`investments holdings` returns `valuationOnly: true` on these rows; their stored
cost remains available for editing but is excluded from cost and gain totals.

For a position with ledger
or manual-row history, submitted units and cost basis must match the computed
values; metadata changes are allowed. It replaces the override, so omitted
display names and price URLs are cleared. Numerical corrections use a dated
`investment add-manual-row` with direction `adjust`, preserving later trades:

```bash
node bin/bunvelope.mjs investment add-manual-row --file budget.json --account INVESTMENT_ACCOUNT_ID --symbol ABC --row '{"date":"2026-10-01","direction":"adjust","units":2,"amount":100,"note":"Opening position correction"}' --dry-run
```

Manual rows change holding units and cost basis, not account balances. Use a
balance command for an account-value correction. `investment set-price` stores
a supplied price in the budget currency; it does not contact a price service.

## Scenario expenses

Scenario expenses are separate from the normal plan and ledger. The paying
account must be an active spending account; reassign or remove its scenario
expenses before archiving/deleting it or changing it out of spending status.
Amounts are monthly costs for A–E
(A most severe), omitted scenarios cost zero, and `months` selects active
calendar months. Payment days are 1–28. No real transaction is posted.

```bash
node bin/bunvelope.mjs stress-expense set --file budget.json --name 'Private healthcare' --account Checking --amounts '{"A":200,"B":100}' --months '{"Jan":true,"Feb":true,"Mar":true,"Apr":true,"May":true,"Jun":true,"Jul":true,"Aug":true,"Sep":true,"Oct":true,"Nov":true,"Dec":true}' --day 15
node bin/bunvelope.mjs stress runway --file budget.json --detail
node bin/bunvelope.mjs stress-expense delete --file budget.json --id EXPENSE_ID
```

Use the returned ID with `stress-expense set --id EXPENSE_ID` to replace an
expense (supply all required fields). `stress runway` includes `extraExpenses`
with annual costs and each scenario's `extraExpense`. A what-if with a Stress
change includes these expenses from that change's month. If several Stress
changes apply, additional costs use the latest starting month (last listed wins
ties), so changing severity does not double the costs. Baseline projections and
ordinary scheduled posting remain unaffected.

## Plan items and templates

```bash
node bin/bunvelope.mjs budget-item create --file budget.json --kind expense --envelope_id Rent --description Rent --default_amount 900 --payment_day 1
node bin/bunvelope.mjs budget-item create --file budget.json --kind expense --envelope_id Insurance --default_amount 300 --monthly_schedule '{"Mar":true,"Sep":true}'
node bin/bunvelope.mjs budget-item update --file budget.json --id Rent --fields '{"default_amount":950}'
node bin/bunvelope.mjs budget-item skip-occurrence --file budget.json --id Rent --month 2026-11
node bin/bunvelope.mjs budget-item unskip-occurrence --file budget.json --id Rent --month 2026-11
node bin/bunvelope.mjs budget-item delete --file budget.json --id Rent
node bin/bunvelope.mjs template create --file budget.json --name "Start of month" --kind manual --lines '[{"envelope_id":"RENT_ENVELOPE_ID","mode":"add","amount":100}]'
node bin/bunvelope.mjs template update --file budget.json --id "Start of month" --fields '{"schedule":{"enabled":true,"payment_day":1,"months":{"Jan":true}}}'
node bin/bunvelope.mjs template delete --file budget.json --id "Start of month"
```

For an expense paid from **Unallocated**, use `--envelope_id null` (or omit
it when creating). In the browser, select **Unallocated** in the envelope
picker. The item still counts as planned spending and reduces Unallocated in
forecasts; scheduled items post expenses without an envelope. Loan payments
and investment purchases still require an envelope.

```bash
node bin/bunvelope.mjs budget-item create --file budget.json --kind expense --envelope_id null --description "Unallocated spending" --default_amount 100
```

Without `--monthly_schedule`, `budget-item create` makes the item active in
every month, as the plan editor's new item starts. A month is active when it is
`true` or an amount; `false` or a missing key is off. An included item must
keep at least one active month: `create` and `update` refuse an empty schedule
(`bad_input` on `monthly_schedule`) unless the item has `"include": false`. A
stored excluded item with no months stays editable.

For a variable account transfer, choose **Transfer → Target balance** in the
Plan editor, select the source and destination, and set the payment day. For
example, target **500** tops Bankcard up to €500; target **0** pays a credit
card's full outstanding balance. Set the day after your usual salary date or
before the card's due date. This is a calendar rule, not a trigger watching
for salary deposits.

```bash
node bin/bunvelope.mjs budget-item create --file budget.json --kind account_transfer --description "Top up Bankcard" --account_id "Income & Expenses" --to_account_id Bankcard --transfer_mode target_balance --target_balance 500 --payment_day 25
node bin/bunvelope.mjs transfer preview --file budget.json --id "Top up Bankcard"
node bin/bunvelope.mjs budget-item top-up --file budget.json --id "Top up Bankcard" --dry-run
```

No fixed `default_amount` is needed for a target transfer. Active months are
on/off; custom monthly amounts become enabled months. Each occurrence moves
`max(0, target − destination balance)`, rounded to cents. Same-day income and
spending count before top-ups, and multiple target rules run in plan order.
At or above the target nothing is transferred back. Transfers change neither
net worth nor envelope budgets and have no fixed annual amount.

The preview returns `today` (posted balances) and `next` (the scheduled
estimate after forecast spending), including `fundingShortfall`. Projections
show the full required transfer and a negative source balance if funding is
insufficient; they do not silently reduce the transfer. Scheduled posting
uses posted history on the payment date and the other rows being posted.
Once recorded, the amount stays fixed. Zero top-ups write no transaction.
A target occurrence replaces the card's default forecast settlement in its
payment month.

**Record extra top-up using saved rule** (CLI `budget-item top-up`) records
another transfer using today's posted balances, with Undo in the browser.
It uses the saved rule even if the editor has unsaved changes. It does not
consume the next scheduled occurrence, whose estimate adjusts to the new
balance. Like other ledger entries, it records money moved; it does not
instruct the bank to send it. Omit `--dry-run` to save the CLI result.

The plan-item editor's **Skipped occurrences** section lists stored skipped
months. **Restore** calls `budgetItem.unskipOccurrence` after flushing queued
plan edits and re-reading the item. It keeps other unsaved form edits and does
not post a transaction; the restored occurrence becomes eligible for normal
scheduling again. This restores plan-item skips, not deleted-transaction
tombstones or template skips. `unskip-occurrence` requires that the selected
month is currently skipped.

`--start_month` and `--end_month` bound a plan item inclusively (`YYYY-MM`,
not for loan-payment items);
`--as_schedule --account_id Checking` enables scheduled posting for an expense
item. Schedule months can be `true` (default amount), a custom amount or `false`
(off). Omitted months are inactive.

A plan item's amount takes any sign: it is stored positive for income and
dividends and negative otherwise, as the Plan editor stores it. An update
changes only the fields it is given, except that giving `kind` re-normalises
the whole item. Template names are unique like account and envelope names; a
manual template takes `lines`, a dynamic one `assignments` (a percent of each
envelope's monthly plan). Deleting either keeps the transactions it already
posted. The system commands that convert income-linked templates and keep loan
payment items in step with their loans are run by the app on load and are not
listed by `help`.

## Allocation and monthly maintenance

```bash
node bin/bunvelope.mjs envelope move --file budget.json --from-envelope Groceries --to-envelope Fun --amount 25
node bin/bunvelope.mjs allocation fill --file budget.json --template "Start of month"
node bin/bunvelope.mjs allocation fill --file budget.json --template "Start of month" --month 2027-01 --skip-template-month true
node bin/bunvelope.mjs allocation fill --file budget.json --lines '[{"envelope":"Groceries","amount":50}]'
node bin/bunvelope.mjs month start --file budget.json --dry-run    # preview what the app does on load
node bin/bunvelope.mjs month start --file budget.json --date 2026-10-10 --cleared
```

`envelope move` (`--from-envelope` / `--to-envelope`; pass the literal `null`
for unallocated, e.g. `--from-envelope null`) and `allocation fill` (manual `--lines`, or `--template`; a
scheduled template's fill carries the occurrence key post-due dedups on;
`--skip-template-month` also skips that occurrence on the template's schedule,
in the same write) post envelope-transfer or fill transactions. An explicit
`--month` needs `--skip-template-month true`: this early fill has no
`from_budget` key, and the saved skip prevents a second posting. `--adhoc`
fills outside a template's schedule, with no occurrence key, scheduled source
envelope leg or once-per-month check; it cannot combine with `--month` or
`--skip-template-month`. An explicit `--from-envelope` can fund a fill from
that envelope instead of Unallocated. `--source new_income` additionally
records incoming cash and requires `--account`, so do not use it for income
already recorded separately.

The `month` commands are `month post-due` (post what has
come due: budget items and scheduled template fills, skipping occurrences
already paid by hand or deleted), `month rollover` (enact each envelope's
rollover policy for the previous month) and `month start`, which catches up
missed months and posts due rows, as
the app does on load (a row counts in the month it belongs to, so a bill for
the closing month is in that month's rollover and a fill for the new month is
not). All three take
`--date` (default today), `--cleared` and `--force`, and are idempotent for the same reference date and unchanged budget: a
second run posts nothing new.

`month start` records `meta.last_rollover_month` in the same atomic write as
its transactions, including months requiring no adjustment. It closes missed
months in order, then resolves later sourced set fills against the swept
balances. A closing month with a scheduled payment shifted to a future working
day waits until that payment is due; later calls retry that boundary.
Without a checkpoint, catch-up starts after the latest legacy rollover marker
(including tombstones), from `meta.last_opened_month` (the legacy setup month),
or from the previous month when neither source exists. Existing
rollover rows and tombstones remain authoritative; this does not rewrite old
adjustments or reconstruct earlier history without a starting marker.
This rollover checkpoint is separate from the `closed_months` metadata set
by `month close`.

## Bulk transaction tools

Use `transaction import` for many new rows in one commit. It accepts JSON rows
in the `transaction record` input shape, not a CSV filename or a stored-row
export. One invalid row refuses the whole import. Schema-declared references
within rows and splits accept IDs or names through the CLI. `force`, if needed,
belongs on the command, not on individual import rows.
For example, save this as `import.json` using the scratch bundle's names:

```json
{
  "rows": [
    { "type": "expense", "amount": 12.30, "account": "Checking", "envelope": "Groceries", "payee": "Market" },
    { "type": "income", "amount": 2500, "account": "Checking", "payee": "Employer" }
  ]
}
```

```bash
node bin/bunvelope.mjs transaction import --file budget.json --input import.json --dry-run
node bin/bunvelope.mjs transaction flag --file budget.json --ids '["TRANSACTION_ID"]' --flagged false
node bin/bunvelope.mjs transaction clear --file budget.json --ids '["TRANSACTION_ID"]' --cleared true
node bin/bunvelope.mjs transaction set-fields --file budget.json --ids '["TRANSACTION_ID"]' --payee Market --envelope Groceries
node bin/bunvelope.mjs transaction merge-transfer --file budget.json --income-id INCOME_ID --expense-id EXPENSE_ID --dry-run
node bin/bunvelope.mjs transaction resolve-duplicates --file budget.json --groups '[{"keep":"KEEP_ID","drop":["DUPLICATE_ID"]}]' --dry-run
```

`set-fields` changes date, payee, envelope and/or `--from-budget`; assigning an
envelope also removes the old plan-item link and splits. `merge-transfer` needs
one income and one equal-amount expense on different accounts; the transfer
keeps both legs' notes (each distinct note once, trimmed, the expense's first,
joined with ` · `).

For different values on different transactions, use `--rows` instead of `--ids`
and shared fields. Each row has a unique `id` and at least one of `date`, `payee`,
`envelope` or `fromBudget`. This performs one ledger check and one atomic save;
an invalid row refuses the entire command. `--force`, if needed, stays at the
command level. Repair Links uses this form:

```bash
node bin/bunvelope.mjs transaction set-fields --file budget.json --rows '[{"id":"RENT_PAYMENT_ID","fromBudget":"rent:2026-10"},{"id":"INTERNET_PAYMENT_ID","fromBudget":"internet:2026-10"}]' --dry-run
```

The occurrence keys must use the actual plan-item IDs and months. Passing
`"fromBudget": null` removes an existing key. Matching rows are left unchanged.

`resolve-duplicates` takes explicit groups; it does not discover duplicates.
The keeper inherits a dropped row's plan-occurrence key when needed so the
occurrence is not posted again. These tools honor the same policies as other
commands.
Imports append new IDs and do not deduplicate or accept an idempotency key.
Retrying a successful import or record command creates additional rows. If a
caller loses the response, inspect the budget before retrying; use
`transactions duplicates` to review possible duplicates.

## Atomic batches

`batch` takes a JSON file with `steps`, using registry names and schema-shaped
inputs, not CLI verb strings. Save this as `ops.json`:

```json
{
  "steps": [
    { "name": "transaction.record", "input": { "type": "expense", "amount": 12.30, "account": "Checking", "envelope": "Groceries" } },
    { "name": "envelope.move", "input": { "fromEnvelope": null, "toEnvelope": "Groceries", "amount": 50 } }
  ]
}
```

```bash
node bin/bunvelope.mjs batch --file budget.json --input ops.json --dry-run --policy strict-ledger
node bin/bunvelope.mjs batch --file budget.json --input ops.json --policy strict-ledger
```

Steps execute in order against the evolving budget and commit once: all succeed
or nothing is written. Only commands can be steps, not queries. Reference
resolution, including nested objects and arrays, happens for **all steps
before execution** against the existing budget. A later step cannot refer to
a record created in the same batch through a schema-declared reference, even
by a predicted ID, and cannot use a name introduced by an earlier rename. There is no
placeholder syntax for earlier step results. Create records first, then use
their IDs in a subsequent batch. For a large import, use `transaction import`
instead of hundreds of `transaction.record` steps.

## Queries and reports

All of these return results under `value` without changing the budget. The
same query definitions serve the app's pages. Run `help VERB` for the complete
input list and each query's scope/defaults.

| Purpose | CLI verbs |
| --- | --- |
| Resolve records and balances | `ref resolve`, `balances`, `forecast balances` |
| Dashboard and cash | `net-worth current`, `cash position`, `cards due`, `spending month`, `spending history`, `age-of-money`, `upcoming` |
| Plan and review | `plan annual`, `plan allocation`, `plan items`, `plan funding`, `review month`, `envelopes month` |
| Diagnostics and cleanup candidates | `budget diagnostics`, `transactions duplicates`, `transactions unlinked`, `transactions transfer-pairs` |
| Template summaries and next fills | `templates summary` |
| Detail and previews | `accounts detail`, `envelope health`, `emergency requirement`, `fill preview`, `loan preview` |
| Stress and projections | `stress runway`, `net-worth history`, `forecast simulation`, `forecast readiness`, `net-worth projection` |
| Reports | `reports spending`, `reports cashflow`, `reports balances` |
| Flow diagrams | `flow plan`, `flow actual` |
| Investment figures | `investments holdings`, `investments performance`, `investments tax` |
| Transaction search | `transactions search` |
| Ledgers and envelope detail | `ledger running`, `envelope forecast`, `envelope history`, `envelopes history` |

### Transaction search

```sh
node bin/bunvelope.mjs transactions search --file budget.json --account Checking --search "grocery shop"
node bin/bunvelope.mjs transactions search --file budget.json --search '#food >=20' --search-mode tokens --limit 100 --offset 0
node bin/bunvelope.mjs transactions search --file budget.json --no-envelope --date-from 2026-09-01 --date-to 2026-09-30
```

Returns `value.{rows,matched,totalMagnitude,offset,limit,hasMore}`. Count and
magnitude total cover **all matches before pagination**; the total is neither
spending nor net cash movement (use `reports spending` for consumption).
The default is stored rows, literal payee/note search, offset 0 and limit 60.
Rows sort by calendar day descending, then reverse stored input order within
the same day. Increase `--limit` explicitly or request successive offsets.
The browser explicitly requests all matches for its virtual list and selection;
the AI retains a 60-row cap. No query changes the bundle.

`--search-mode tokens` enables the browser language: ANDed words, quoted
phrases, exact `#tags`, and numeric comparisons with the existing 0.005 amount
tolerance. Explicit `--min-amount`/`--max-amount` bounds are inclusive and use
magnitude. Account/envelope filters include split legs, transfers, fills and
adjustments. `--no-envelope` selects uncategorized expenses/debt payments and
cannot combine with `--envelope`. `--cleared`, `--flagged`, `--type`, `--status`
and inclusive date bounds further narrow matches.

`--show-scheduled` includes the browser's deduplicated scheduled preview from
`--date` (default session clock) through 30 days ahead, widened by date bounds.
Running balances remain a separate `ledger running` query over complete history.

### Diagnostic discovery

```sh
node bin/bunvelope.mjs budget diagnostics --file budget.json --date 2026-09-15
node bin/bunvelope.mjs transactions duplicates --file budget.json
node bin/bunvelope.mjs transactions duplicates --file budget.json --include-dismissed
node bin/bunvelope.mjs transactions unlinked --file budget.json --envelope Groceries --date 2026-09-15
node bin/bunvelope.mjs transactions transfer-pairs --file budget.json
node bin/bunvelope.mjs transactions transfer-pairs --file budget.json --since 2024-01-01 --days 5
```

`transactions duplicates` returns `value.groups`: stable `id`, candidate `ids`,
transaction `rows` as evidence, `kind`, suggested `keepId`, occurrence `key`,
dismissal `pairs`, and `recommended`. Groups are ordered by confidence
(`sameKey`, `postedOverHand`, then `plain`) and oldest date. Dismissals are
respected unless `--include-dismissed` is set. Recommendations require review;
a plain match can represent two real purchases.

`transactions unlinked` returns `value.proposals`: occurrence `key`, item and
envelope details, due date/amount, and matching `txId`, date, payee and amount.
Account-transfer proposals also include `fromAccount` and `toAccount`; an
`--envelope` filter excludes transfers. Linked/skipped occurrences, ambiguous
matches and ineligible plan items are omitted. `--date` defaults to the session
clock, shared with the browser.

`transactions transfer-pairs` finds expenses that are really transfers: an
expense on one of the budget's accounts and an income of the same amount on
another (archived accounts included), at most `--days` apart (default 3), under
the same payee as `payeesSimilar` compares them (folded case, accents, store
numbers and legal suffixes; a whole-word part counts). A pair where only one
payee reads as a refund ("Prisma" and "Prisma return") is left out. Scheduled
rows, rows after `--date` and rows in a reversal are never paired, and both
rows must be on or after `--since` (default 12 months before `--date`).
`--any-payee` also pairs rows whose payees differ, which mostly adds refunds and
reimbursements. It returns `value.{pairs,dismissed,since,days}`; each pair has `id`
(`incomeId|expenseId`), `incomeId`, `expenseId`, `date` (the earlier one),
`amount`, `days`, `payeeMatch`, `fromAccount` (the expense's account),
`toAccount`, `payee`, and both legs as `income` and `expense` evidence. Each
row is in one pair at most (same payee, then the closest dates, win). Merge a
pair with `transaction merge-transfer --income-id ID --expense-id ID`.
A pair marked "Not a transfer" in the app's Clean-up sheet is stored by its
`id` in `meta.transferPairDismissed`; it is left out of `pairs` (its rows may
then pair with another partner) and listed under `dismissed` while it would
otherwise be found, so the CLI and the app list the same pairs. The sheet's
lookback (last 12 months, 2 years, all) is the same `--since`.

`budget diagnostics` returns the invariant `report`, the same `groups` and
`proposals`, `extras` (`unlinked` and `postedDuplicates` counts plus
`archivedFuture` row details), and `totalCount`. The badge total is invariant
problems + unlinked proposals + posted-over-hand groups + archived future rows.
Plain duplicate candidates do not raise the badge; same-key violations are
already included in the invariant report.

These queries never write or apply repairs. After reviewing candidates, use
`transaction resolve-duplicates` or `transaction set-fields --from-budget` (or
an explicit batch of those commands); preview changes with `--dry-run` first.

### Balances, dashboard and review

```bash
node bin/bunvelope.mjs balances --file budget.json --lens today
node bin/bunvelope.mjs balances --file budget.json --lens booked --as-of 2026-09-30
node bin/bunvelope.mjs balances --file budget.json --lens forecast --horizon eom
node bin/bunvelope.mjs forecast balances --file budget.json --date 2026-12-31 --cards settle-15th --card-funding-account Checking
node bin/bunvelope.mjs net-worth current --file budget.json --lens booked
node bin/bunvelope.mjs cash position --file budget.json --lens booked
node bin/bunvelope.mjs cards due --file budget.json --lens booked
node bin/bunvelope.mjs spending month --file budget.json --month 2026-10
node bin/bunvelope.mjs spending history --file budget.json --months 6
node bin/bunvelope.mjs plan annual --file budget.json --date 2026-10-01
node bin/bunvelope.mjs age-of-money --file budget.json --months 12
node bin/bunvelope.mjs upcoming --file budget.json --days 30
node bin/bunvelope.mjs envelopes month --file budget.json --spare false
node bin/bunvelope.mjs review month --file budget.json --month 2026-10 --envelope Groceries
```

`balances` requires `--lens`: `today` means cleared as of today, `booked` means
everything entered (including scheduled rows), and `forecast` adds generated
rows through `--horizon` (default `3m`; also `eom`, `6m`, `12m` or a date).
`--as-of` is available only with `booked`. Other lens-aware queries generally
default to `booked`; consult their help. `--date` on a query can select a plan
or reporting date while its lens still uses the current day; it does not
universally make the query historical. Global `--now` moves the calculation
clock, but the query still reads the supplied bundle, including its current
settings and stored holdings.

`balances` includes envelope/account totals and assigned percentage.
`envelopes month` includes `spare.lowBalance`, the lowest projected balance before subtracting `spare.floor`; `spare.lowDate` is its date.

`envelopes month --spare false` skips per-envelope projections while retaining
balances, plan, buffer and goal figures (funding is also omitted). `planned`
is the coming-year average; `monthPlanned` is the plan for the date's own
calendar month (skipped occurrences left out), what `spent` is compared with on
the card; `fillPlanned` is the monthly amount dynamic
templates fund, including the full rate for items through their end month.
With spare enabled, rows also include plan-item funding and the spare floor/low
date. `review month` includes overall/category totals, negative counts and
consolidation amounts, and per row `need` (the gap to the required reserve,
zero on a surplus; the Fill sheet's "fill to need"); `--envelope` adds detail.
The projected month-end balance includes remaining scheduled template fills
(including multiple fills per month), with posted/deleted occurrences excluded
from the forecast. Set fills use the balance on their date; fills drawing from
another envelope reduce that source's projection. Future months with explicit
fills do not also receive an assumed monthly deposit.
A past `--month` is reviewed as it stood at its last day (`isPast: true`,
`asOf` that day): only rows dated by then, balances as of then, nothing
forecast; the current and future months are reviewed as of the clock. `cards due` reports amounts
owed, not payment due dates.

`age-of-money` counts transfers where they cross the spending accounts' edge:
money moved out (to savings, investments, a loan's principal) uses up the
oldest money first but is not averaged as spending, money moved in counts as
income, and a transfer between two spending accounts is neutral. It leaves
one-off inflows out of the money it ages: an income row
above 3× the median monthly income of the 12 calendar months before it (with at
least 3 such months), such as a house sale or a share payout. They fund
spending only when the regular income has run out, and `oneOffs` lists those
dated in the history's months. `health` is `green` only with at least 90 days of
runway; `runwayLimited` is `true` when the runway held it at `yellow`.

`review month --include-archived` reviews archived envelopes too, each row
carrying `archived`. `envelopes month` defaults to active envelopes; select an
archived envelope explicitly by ID in `--envelopes` to include it. `balances`
hides archived rows by default (`--include-archived` lists them), but its
totals and Unallocated still count them.

`cash position` counts only active spending accounts in its headline, count and
trend. Historical account reports still retain archived accounts.

`spending month` preserves `planned` and `spentPct` as the annual-average
comparison for existing callers. `averageMonthlyFunding` explicitly names that
same average. New `calendarPlanned` and `calendarSpentPct` use the selected
month's expense calendar; the Dashboard uses these new fields.

### Reports, flow and investment holdings

```bash
node bin/bunvelope.mjs reports spending --file budget.json --group-by payee --from 2026-01-01 --to 2026-09-30
node bin/bunvelope.mjs reports cashflow --file budget.json --from 2026-01-01 --to 2026-09-30
node bin/bunvelope.mjs reports balances --file budget.json --lens booked
node bin/bunvelope.mjs plan allocation --file budget.json
node bin/bunvelope.mjs flow plan --file budget.json --period year
node bin/bunvelope.mjs flow actual --file budget.json --from 2026-01-01 --to 2026-09-30
node bin/bunvelope.mjs investments holdings --file budget.json
node bin/bunvelope.mjs investments tax --file budget.json --year 2026
node bin/bunvelope.mjs investments performance --file budget.json --from 2026-01-01 --to 2026-09-30 --now 2026-10-06
node bin/bunvelope.mjs ledger running --file budget.json --account Checking --show-scheduled
node bin/bunvelope.mjs envelope forecast --file budget.json --envelope Groceries --months 12
node bin/bunvelope.mjs envelope history --file budget.json --envelope Groceries --months 12
node bin/bunvelope.mjs envelopes history --file budget.json --months 6 --envelopes '["ENVELOPE_ID"]'
```

`reports spending` requires `--group-by envelope|payee|month`; `flow plan`
requires `--period month|year`. `ledger running` needs one account or envelope
and returns row/day balances. `investments tax` uses the selected year if it
has sales, otherwise the newest year with sales. Its `totals.deductedCost` is
what the return deducts (acquisition cost plus sale expenses, or the deemed
cost), so `grossProceeds - deductedCost = net`; `purchaseCost` is the
acquisition cost alone, which the EUR 1,000 small-sales rule reads. Investment writes use the
singular `investment`; read queries use the plural `investments`.

`investments performance` reports period money gain/loss and personal return as
Modified Dietz (a cash-flow-weighted estimate, not annualized). Dates are inclusive;
the opening valuation uses the previous day's close. It includes posted trades
and dated manual buy/sell corrections in all tracked investment accounts, including
archived ones, or one `--account`. Broker cash and untracked accounts are excluded.
Fees enter once through recorded cash amounts; dividends count as distributions.
Within-period unit-only corrections block the return because their cash treatment
is unknown. Missing units, oversold positions, undated holdings, or missing/old
boundary prices yield `complete: false` and null aggregate valuations/gain/return.
`issues` and per-holding price dates identify the gaps. Trade-backed issues include
`transactionId` or `manualRowId` to identify the exact source record, even when
several trades share a date. `--max-price-age-days 0`
requires exact boundary quotes; the default allows seven days. A nonpositive
weighted-capital denominator yields a null percentage even with complete prices.

To fill a historical quote without replacing a newer current quote:

```bash
node bin/bunvelope.mjs investment set-price --file budget.json --symbol VWCE --price 120 --as-of 2025-12-31 --preserve-newer
```

Use verified closing prices in the budget currency. The Performance tab offers
the same dated-price entry. Without `--preserve-newer`, the existing `set-price`
behavior is unchanged: the supplied quote also replaces the current quote.

Money flow's plan query splits dated loan payments into principal (Debt
repayment) and interest plus fees (spending in their envelope), using the loan
schedule from the opening of the selected period. Legacy loan items without a
payment day retain the whole-payment transfer estimate. Actual net envelope
credits appear as sources, including a refund greater than that envelope's
spending in the selected range.

### Template summaries and pending fills

```bash
node bin/bunvelope.mjs templates summary --file budget.json
node bin/bunvelope.mjs templates summary --file budget.json --date 2026-10-01 --templates '["TEMPLATE_ID"]'
```

`templates summary` returns `value.templates` in stored template order. Omit
`--templates` for all templates; the array accepts IDs or names in the CLI,
and `[]` returns none.
Each row has `id`, `lineCount` (stored lines or dynamic assignments),
`resolvedLines`, `total` (sum of absolute line amounts), and `nextPending`
(`{ date, monthKey }` or `null`). Dynamic amounts use the template-funding view
as of `--date` (default today): an item already running keeps its full monthly
average through its end month; an upcoming item counts only its active months
in the coming twelve months. Ended items contribute nothing. Summary lines
retain missing/archived envelope references; actual fills filter those references.
Amounts are rounded to cents; the total is rounded after summing.

The pending search reaches thirteen months ahead and excludes posted keys,
deleted occurrences and skipped months. It includes an occurrence whose
schedule date has passed but whose bank-day-shifted payment date is still
ahead; `monthKey` remains the occurrence's month even when `date` crosses a
month/year boundary. It is a future-fill preview, not a list of overdue or
due-today fills. Disabled/ended schedules and templates with no eligible fill
in that window return `null`.

The Templates card and its “Fill now” choice read this same query. The action
queries again when opened so it does not reuse a stale card's occurrence.
A set-mode line is a target, not the amount that will move: use
`allocation fill --dry-run` to validate and preview the actual write. New
stored fills are add-only: `allocation fill --template` and the
scheduled fills `month post-due` and `month start` write each set line as its
delta to the target on the balance the fill meets (negative when the envelope
already holds more), with the target in `set_target`; a target already met
stays as a zero line when other lines still move money; an entirely zero
fill returns `fill_nothing_to_fund` for `allocation fill`. Older stored
set-mode rows are not migrated. `set_target` preserves the target when a
rollover replays a later month's early fill.

### Account detail, envelope health and previews

```bash
node bin/bunvelope.mjs accounts detail --file budget.json --lens booked --repayment false
node bin/bunvelope.mjs envelope health --file budget.json --envelope Groceries --months 12
node bin/bunvelope.mjs emergency requirement --file budget.json --month 2026-10
node bin/bunvelope.mjs plan items --file budget.json --date 2026-10-01
node bin/bunvelope.mjs plan funding --file budget.json --date 2026-10-01
node bin/bunvelope.mjs fill preview --file budget.json --lines '[{"envelope":"Groceries","amount":50}]' --envelopes '["ENVELOPE_ID"]'
```

`accounts detail` includes Today/lens balances, portfolio values, interest estimates, loan terms
and repayment schedules; `--repayment false` skips schedule construction.
`portfolioValue` is the current value of stored holdings, independent of the balance
lens or `--date`, with cost used for unpriced holdings. It includes holding
overrides and manual rows: an empty tracked investment account returns `0`;
an untracked or non-investment account returns `null`. Archived accounts are
included when selected, just like other account detail fields.
A loan given's `loanTerms.accrued` and `atDue` are the interest outstanding
now and on the cycle's due date: every day's interest since the loan's start,
less `received`, the income linked to it with `--interest-of`.

`envelope health` adds daily projections, recommendations and item funding to
the envelope's lens/as-of balances. `emergency requirement` returns the full
breakdown, or `null` when no emergency envelope is configured. `plan items`
returns each item's annual amount and loan rate, with plan totals; it accepts
`--item-overrides` like `stress runway` (see below for the allowed fields). `plan funding` reports every funded
plan item's fill percentage, status, shortfall and next due amount, with its
envelope ID. It uses stored balances as of `--date` and a 12-month projection.

`fill preview` requires both proposed lines and the envelope IDs to report.
It projects spare after a hypothetical fill without writing; it does not
validate a real allocation command. Use `allocation fill --dry-run` to check
whether the actual write would be allowed.

`loan preview` takes draft loan-payment fields and an existing loan account.
For example, with an account named Mortgage:

```bash
node bin/bunvelope.mjs loan preview --file budget.json --loan Mortgage --item '{"default_amount":500,"loan_method":"fixed_payment","payment_day":1,"monthly_schedule":{"Jan":true,"Feb":true,"Mar":true,"Apr":true,"May":true,"Jun":true,"Jul":true,"Aug":true,"Sep":true,"Oct":true,"Nov":true,"Dec":true}}'
```

The result includes the first payment, payoff date, total interest, amount
still owed, last payment month and how the schedule ends. Drafts and previews
do not create plan items or transactions. The session API's `queryAfter` is
available to JavaScript callers, but is not a CLI verb or a `batch` query step.

### Stress and what-if projections

```bash
node bin/bunvelope.mjs stress runway --file budget.json --detail
node bin/bunvelope.mjs stress runway --file budget.json --item-overrides '[{"id":"PLAN_ITEM_ID","fields":{"stress_cut_pcts":{"A":0.5}}}]' --detail
node bin/bunvelope.mjs net-worth history --file budget.json --months 24
node bin/bunvelope.mjs forecast simulation --file budget.json --months 24 --alerts false
node bin/bunvelope.mjs forecast simulation --file budget.json --months 24 --what-if SCENARIO_ID
node bin/bunvelope.mjs net-worth projection --file budget.json --years 10 --contribution plan --account-overrides '[{"id":"ACCOUNT_ID","expectedGrowth":5,"plannedMonthly":100}]'
```

`--what-if` names a saved scenario ID. Item/account overrides affect the query
only and do not save edits. Item overrides use literal plan-item IDs and
allow only `stress_cut_pcts`, `stress_category`, `stress_cut_pct`,
`monthly_schedule`, `include` and `include_in_emergency_budget`; later entries
for an ID override earlier fields, and unknown IDs are ignored. Account
overrides also use literal IDs, allow `expectedGrowth` and `plannedMonthly`
(or `null` to clear them), and ignore unknown IDs.
`--exclude-accounts` filters simulation/projection
totals, not which accounts are walked; simulation alerts ignore that exclusion.
`forecast simulation` covers 1–60 months (default 24); `net-worth projection`
requires 1–50 years. Runway values distinguish `months`, `unlimited` and `none`.

## Protocol commands for scripts

The original protocol remains version 1. These commands talk only to Postgres,
accept optional `--user`, and do not take core globals such as `--file`,
`--policy`, `--now` or `--dry-run`.

| Command | Required options | Result |
| --- | --- | --- |
| `budgets list` | None | `budgets`, including IDs, versions and owner emails |
| `budget probe` | `--id` | `budget` metadata: version, schema, encryption flag, blob count |
| `budget read` | `--id` | `budget` metadata and the `bundle` object |
| `budget apply` | `--id`, `--expected-version`, `--input` | New `version` and `changed_kinds` |

`budget apply` replaces the supplied collections; it is not a domain command
or an append/patch operation. Prefer core commands for ordinary edits so
command rules and policies run. Apply validates the store write (including
account references) but does not execute the core command/policy pipeline.
Keep a backup and supply the **complete** contents of every collection you
replace. For example, this empty envelope-template replacement is appropriate
only when deliberately removing all templates:

```json
{
  "protocol_version": 1,
  "expected_version": 12,
  "items": [
    { "kind": "envelopeTemplates", "data": [] }
  ]
}
```

Save it as `apply.json` and use the actual version from a fresh read in both
the file and argument:

```bash
node bin/bunvelope.mjs budget apply --id BUDGET_UUID --user owner@example.com --expected-version 12 --input apply.json
```

Valid kinds are `accounts`, `envelopes`, `transactions`, `budgetItems`,
`envelopeTemplates` and `meta`. The file's `expected_version` must match the
argument. A stale version returns `version_conflict`; re-read and reconcile
before retrying. Unlike core commands, protocol apply does not automatically
reload/recompute. Bulk input goes in a file; credentials belong in the
environment or `.env`, never command arguments. For backup restore, use the
[backup/restore workflow](backups.md), whose file format is separate.

## Output, exit codes and troubleshooting

Successful operations write one JSON document plus a newline to stdout with
`protocol_version: 1`. Queries add `value`; core writes add `value`, `diff`,
`forced`, `committed`, and `version` (`null` for file mode). Batch `value` is the
list of step results. Help is the plain-text exception.

The write envelope has this structure (a no-op example):

```json
{
  "protocol_version": 1,
  "value": { "delta": 0, "balance": 0 },
  "diff": {},
  "forced": [],
  "committed": false,
  "version": null
}
```

`value` is command-specific: `transaction record` returns the row directly,
`transaction import` returns `{ "rows": [...] }`, and `transaction reverse`
returns `{ "reversal": [...] }`. Read new IDs from those results. The final
stored rows in `diff` also include commit-time normalization and payee aliases.

`diff` contains only changed collections. Array collections have `added` and
`removed` entries shaped as `{ row, index }`, `changed` entries shaped as
`{ id, before, after }`, and optional `order: { before, after }` ID arrays.
Metadata uses `meta.changed: [{ key, before, after }]`; absent JSON fields
represent a previously missing or removed key. Audit-log appends happen after
this diff is computed and are not listed in it. The diff is for inspection,
not an input accepted by `budget apply`.

`committed: false` covers both dry runs and no-ops; a dry run may have a
nonempty diff. `forced` lists policy rules actually bypassed, not every use of
`--force`. A Postgres write returns the new version, while a dry run/no-op
returns the version read. Core commands have no caller-supplied
`--expected-version` option. Queries do not return a version; protocol
`budget read` returns it under `budget.version`.

Errors go to stderr as `{"protocol_version":1,"error":{...}}`, with `code` and
`message`. Core errors usually include `params` (for example validation paths
or a failing batch step); store conflicts can include `current`. With
`PGSSL=no-verify`, a warning line precedes any JSON error on stderr, so stderr
is not always a single JSON document. Keep stdout and stderr separate.
For example, a missing required query field produces an error like:

```json
{
  "protocol_version": 1,
  "error": {
    "code": "bad_input",
    "message": "Invalid input: lens is required",
    "params": { "errors": [{ "path": "lens", "message": "is required" }] }
  }
}
```

Branch on `error.code` and `params`, not the human-readable message. Batch
`params.step` is zero-based. A `--file` bundle that does not exist fails
`file_not_found`; one that cannot be read or is not JSON fails
`file_unreadable`. Both carry the path in `params.path`.

| Exit code | Meaning |
| --- | --- |
| `0` | Success (including help, dry runs and no-op writes) |
| `1` | Domain/schema/policy, file, database or connection failure; **all protocol-command errors**, including bad arguments |
| `2` | Generated CLI argument/flag parsing errors, such as unknown verbs, conflicting selectors or unreadable `--input` files |

Schema failures after parsing (including missing required inputs) can exit 1;
do not assume every `bad_input` is a usage exit 2. Check the error code and
parameters as well as the exit status.

- `ref_not_found` / `ref_ambiguous`: resolve the record, use its ID, and check
  whether it is archived. Schema-declared references also resolve names inside nested JSON; ordinary string IDs remain literal.
- `bad_arguments` / `bad_input`: use `help COMMAND`; check flag spelling,
  required inputs, JSON quoting and the difference between `--budget` and `--id`.
- `file_not_found` / `file_unreadable`: check the `--file` path (relative paths
  resolve from the current directory) and that the file is the extracted
  bundle JSON.
- `in_use`: archive an account/envelope or remove its references before deleting.
- `ledger_history_locked` / `ledger_future_posted`: inspect the active policy
  and the proposed diff; schedule future rows or use a correction/reversal.
- `encrypted_budget` / `unsupported_schema`: use the browser for encrypted
  budgets or schema migration; see the data-source limitations above.
- `version_conflict`: another writer changed the budget; re-read before retrying.
- `connection_failed` / `tls_verification_failed`: check `DATABASE_URL`, Postgres
  availability and the [local setup/TLS instructions](running-locally.md#troubleshooting).

For contributors, CLI parsing is in [bin/cli-dispatch.mjs](../bin/cli-dispatch.mjs),
flag conversion in [js/core/cli-flags.js](../js/core/cli-flags.js), and persistence
in [server/session/node-session.js](../server/session/node-session.js). Add new
public operations and flags through the registry schemas and update this guide
when usage changes. Database-free CLI smoke tests live in `tests/cli-*.test.js`;
`tests/headless-cli.test.js` exercises the Postgres protocol with a throwaway DB.

### Recurring costs and review reminders

`recurring costs` lists scheduled expense plan items, next pending payments, and
review/cancellation/renewal dates. Totals cover the next 12 months from the query
date; the monthly equivalent is that total divided by 12, not a monthly debit.
Buffers, hidden, paused and ended items are excluded from tracked totals. Hidden
items remain in the query with `hidden: true` and their own cost figures. Skips, deleted
occurrences, dated bounds, custom month amounts and bank-day shifts are honoured.
Posted occurrences remain part of the period's planned cost but are not offered
as the next pending payment. This is planned cost, not a remaining-cash forecast.

```bash
node bin/bunvelope.mjs recurring costs --file /tmp/budget.json --date 2026-10-07
node bin/bunvelope.mjs budget-item update --file /tmp/budget.json --id music --fields '{"recurring_review":{"linked_reminder":true,"cancel_by":"2026-11-30","renews_on":"2026-12-31","reminder_days":30,"category":"Streaming","hidden":false,"notes":"Compare providers"}}'
```

`recurring_review` is optional. Providing it replaces that reminder object; null
clears it. Preserve the other fields when changing one through the CLI. The UI
preserves category and visibility when editing reminder settings.

- `category` is a free-text group (e.g. Streaming, Insurance, Phone, Electricity).
  The view groups and filters categories case-insensitively; blank means Uncategorized.
  The query's `categories` array returns each group's key, name, monthly equivalent
  and next-12-month total, excluding hidden items. Category header totals remain
  stable when filtering cards. Drag the category handle or use the Up/Down
  controls to reorder sections; the order is saved as a display preference.
  `groups` also contains account, envelope, envelopeCategory and ungrouped (`none`)
  totals. Items expose account/envelope IDs and names, envelope category and
  `renewsOn` (null for continuous agreements). Accounts and envelopes group by ID,
  so identical names do not combine unrelated records.
  In the UI, Group by and Sort are saved independently. Renewal sorting uses the
  explicit renewal date within each group, with undated items last; choose No
  grouping for one earliest-first list. Each grouped view retains its own section order.
- `starts_on` is an optional agreement start date for reference only; it does
  not control when scheduled payments begin.
- `continuous: true` means until further notice. Renewal/end/cancellation dates
  and the Plan end fallback are ignored for reminders, and their editor controls
  are disabled. An optional `review_on` still provides a single exact review
  reminder; days-before does not apply. Plan dates and payment amounts are unchanged.
- `hidden: true` removes an item from tracked totals and suppresses all reminders
  in both Overview and Recurring costs. It does not pause payments or affect forecasts.
  Use the Hidden filter and Unhide to restore tracking.
- `reminder_days` is an integer from 0 to 3650, default 45. It is the number of
  **calendar days before** `renews_on`, `ends_on` or `cancel_by` at which the reminder
  starts. A 2026-12-31 renewal defaults to a 2026-11-16 reminder (45 days);
  explicitly choosing 30 days gives 2026-12-01.
- `linked_reminder: true` produces one reminder. Supply either `renews_on` or
  `ends_on`; renewal takes precedence if both are supplied through the CLI.
  An earlier `cancel_by` becomes the reminder deadline. In the example above,
  the reminder starts on 2026-10-31, thirty days before cancellation is due.
  The web editor uses a Renews/Ends switch and linked **Remind me on** and
  **Days before** fields. Saving converts older settings to this mode and
  preserves the earliest reminder date shown in the editor.
- Older records without `linked_reminder` retain independent date reminders
  until edited. `review_on` starts on its exact date; in linked mode it is used
  only for a legacy standalone reminder with no deadline. `ends_on` falls back to the Plan end date
  when blank. An explicit agreement end date is for reminders only; edit Plan to
  stop future payments. Paused and ended plan items produce no reminders.

The query returns `remindFrom` and `due` per reminder. Due reminders appear in
Overview and under Needs attention in Recurring costs; they stay due until dates
are moved/cleared or the item is hidden. These are in-app notices, not email or
push notifications. They never cancel a service or modify payments. The editor
previews the reminder start dates before saving.

### Discover overlooked recurring costs

`recurring suggestions` scans up to 36 calendar months of posted manual expenses,
locally in every storage mode, without AI. It groups by payee (including saved
aliases) and account and looks for a recent consecutive pattern: three monthly
or quarterly payments, or two annual payments. Dates may vary by seven days and
amounts within 15% of the latest payment qualify as stable (a clear price step also qualifies). Variable amounts require four monthly/quarterly payments or three yearly payments, and use the average of up to 12 latest matching payments. Patterns more than 45 days overdue are
excluded. This is deliberately conservative: sparse history and
multiple purchases at the same merchant can be missed. It does not infer that a
service is unused or infer contractual renewal dates.

Suggestions include `key`, `status` (pending/dismissed/linked), evidence, latest
amount, estimated yearly/monthly cost and a suggested future `firstDate`. Known
scheduled expenses (including hidden ones) are excluded using matching payee and
account or an existing payment's schedule reference. Discovery never changes
balances, history or forecasts. Dismissed and linked suggestions remain available
for review while their historical pattern still qualifies; deleting a linked
schedule makes the pattern eligible again.

```bash
node bin/bunvelope.mjs recurring suggestions --file /tmp/budget.json --date 2026-10-07
# Copy the exact key returned by the query. The example is Music, bank, monthly.
node bin/bunvelope.mjs recurring review-suggestion --file /tmp/budget.json --key '["music","bank",1]' --action dismiss
node bin/bunvelope.mjs recurring review-suggestion --file /tmp/budget.json --key '["music","bank",1]' --action restore
node bin/bunvelope.mjs recurring review-suggestion --file /tmp/budget.json --key '["music","bank",1]' --action link --item-id music
# Or create a future schedule after reviewing the suggestion:
node bin/bunvelope.mjs recurring review-suggestion --file /tmp/budget.json --key '["music","bank",1]' --action create --first-date 2026-11-01 --dry-run
```

Use `--now 2026-10-07` to reproduce these historical examples. Review commands
recheck availability using the session clock. `create` requires a date after
today, creates the expense schedule and association in one atomic command, and
uses the detected amount, account, frequency and latest envelope (Unallocated
if that envelope no longer exists or is archived). It does not insert past
payments. Edit the resulting item in Plan to change its schedule or amount.
`link` only associates an existing expense schedule; it does not rewrite ledger
history. `restore` removes the saved dismissal/association without deleting a
schedule. The browser exposes these actions under **Possible recurring costs**.


### Review recurring price increases and variable bills

`recurring suggestions` also returns `priceIncreases`, using posted manual **and**
scheduled expenses. An alert requires at least two prior payments stable within
2%, followed by an increase of at least 5% and 0.50 in the budget currency. It
shows old/new amounts, payment evidence and `extraAnnual`, assuming the higher
payment continues. Higher usage or a one-off fee can also explain an increase;
this is a review prompt, never an automatic schedule update. Hidden or paused
tracked items do not produce alerts. A stable higher-price run keeps the same
alert identity; a subsequent increase creates a new review.

```bash
node bin/bunvelope.mjs recurring suggestions --file /tmp/budget.json --now 2026-10-07
# Copy a priceIncreases[].key verbatim into --key:
node bin/bunvelope.mjs recurring review-price --file /tmp/budget.json --key '<returned-key>' --dismissed true
node bin/bunvelope.mjs recurring review-price --file /tmp/budget.json --key '<returned-key>' --dismissed false
# Override an estimate only when confirming a new schedule:
node bin/bunvelope.mjs recurring review-suggestion --file /tmp/budget.json --key '["utility","bank",1]' --action create --first-date 2026-11-01 --amount 75 --dry-run
```

Variable suggestions include `variable`, `minAmount`, `maxAmount`, `latestAmount`
and the estimated average in `amount`. The confirmation editor allows changing
that amount; actual payments remain untouched. Price reviews and their dismissed
list appear on Recurring costs, alongside an Edit payment action when exactly
one existing schedule matches.

The Templates AI card's Add scheduled action now opens a prefilled Plan editor.
The user selects an account and reviews the amount and schedule before saving.
Monthly, quarterly and annual drafts begin on the first of next month, visibly
editable in Plan. Unsupported weekly/unknown cadences stay unscheduled, with all
months unchecked and an explanation, rather than being converted to monthly.

### Spending profiles and forecast timing

`spending.profile` explains an envelope's expected payment-account mix:

```bash
node bin/bunvelope.mjs spending profile --file budget.json --id Groceries --now 2026-10-07
node bin/bunvelope.mjs envelope update --file budget.json --id Groceries --fields '{"forecast_account_shares":[{"account_id":"Bankcard","percent":20},{"account_id":"Mastercard","percent":80}]}' --dry-run
node bin/bunvelope.mjs envelope update --file budget.json --id Groceries --fields '{"forecast_account_shares":null}' --dry-run
```

The default profile uses posted purchase **amounts**, split by envelope, from six
calendar months including the reference month through the reference day. Monthly
weights are 1 through 6, oldest to newest. Future rows, transfers and archived
accounts do not train the profile. With no envelope history it uses household
purchase shares, then an active spending account; these fallbacks are labelled
limited. At least 12 purchases across three months are needed for an established
profile; a monthly account mix differing by over 25 percentage points in total
variation is labelled variable. These are descriptive indicators, not statistical
confidence intervals. An explicit live plan-item account takes priority.

`forecast_account_shares` is an optional envelope override. Each active payment
account can occur once; positive percentages must sum to 100. `null` restores
history. The envelope editor exposes these settings under **Spending forecast**.

After netting recorded payments, undated items with funding style `spending` are
spread evenly from tomorrow through month-end (future months use the full month).
Date bounds and skipped occurrences still apply. Items with payment dates and
items with funding style `bill` keep their dates; undated bills stay at month-end.
Rounding preserves each monthly amount exactly. A shorter horizon truncates the
same daily rows, rather than reallocating the full month into fewer days.

The shared forecast lens, effective transaction lists, account simulation and
envelope projections use these rules. Top-ups and credit-card repayments resolve
against the resulting balances. Estimates never create posted transactions.
`overview.attention` adds `estimated: true` when a cash warning includes inferred
spending or transfers affected by it; the dashboard labels it a possible shortfall.

## Review a bank statement

`import review` is read-only. It compares signed statement rows with one account,
using confirmed payee aliases and one-to-one matches. It returns `recorded`,
`review`, `missing` and `pending` groups. Only likely missing rows are included by
default. Shifted dates and different merchant names remain reviewable, and older
rows covered by a later account adjustment start excluded.

```bash
node bin/bunvelope.mjs help import review
node bin/bunvelope.mjs import review --file budget.json --account Checking --rows '[{"key":"row:0","date":"2026-10-10","payee":"Shop","amount":-12}]' --target 88 --date 2026-10-10 --basis booked
```

Use a unique `key` for each row. Optional `bankStatus` is `booked` or `pending`;
`bankBalance` is the bank's running balance. If there is only one running balance
on the latest booked day, it can supply the target. Otherwise supply `--target`.
`--date` defaults to the latest booked statement day. `--basis available` describes
a balance including reservations; the default is `booked`. Pending matches are
shown as possible explanations, never silently removed from the recorded ledger.

`balance` reports the posted ledger, selected-row change and projected ledger.
`ledgerRemaining` is the literal bank target minus that projected ledger, so
every selected row, including a pending reservation, changes it. The import
screen presents this as its main remaining difference and checks the same
figure after saving. A projected account balance is not itself a difference.
`comparisonLedger` and `comparisonProjected` estimate the selected balance basis:
matched reservations are removed for booked balance, and all statement
reservations are counted once for available balance. `remaining` uses that
comparison. Uncertain reservation matches suppress combination suggestions.
For imports opened from Check balance, `--checked '["transaction-id"]'` selects
reconciliation mode. The starting balance includes the opening balance, cleared
transactions and these checked IDs. An empty array includes only cleared rows.
Matching still uses the full ledger, so unchecked existing rows remain detectable
as duplicates. The main difference uses this checked balance plus selected imports;
the statement target stays fixed when transactions are checked or unchecked.
Reservation basis estimates, including the legacy `reconcileTarget` output, are
not applied to the Check balance target.
Pass `--selected '["row:0"]'` to preview an explicit choice;
rows after the balance date cannot be included. `suggestion` reports `unique`,
`ambiguous`, `none`, `balanced`, `pending`, `noTarget` or `limited`. A unique
combination is supporting evidence only and does not change the selection.
Pending, already recorded and historically adjusted rows are excluded from the
combination search. A bounded search reports `limited` rather than claiming
uniqueness when it cannot check all combinations. Nothing is imported or adjusted.
For a later `transaction import`, pass `--expected-statement` with an object
containing the reviewed `account` and the query's exact `context` string. The
command checks the account ledger and aliases again when committing and refuses
`import_review_changed` if they changed. Re-run the review before retrying.

## Import rules

`import-rule create|update|delete` manages optional naming and envelope suggestions;
`import-rules list|preview` inspects them without importing transactions. Rules
match original merchant text, signed direction, an optional account and an
inclusive absolute amount range. They never change amounts, dates or accounts.
Conflicting actions are returned as alternatives rather than silently ordered.

```bash
node bin/bunvelope.mjs import-rule create --file budget.json --name Groceries --conditions '{"merchant":"SHOP","operator":"equals","direction":"expense"}' --actions '{"envelope":"Groceries"}' --dry-run
node bin/bunvelope.mjs import-rules list --file budget.json
node bin/bunvelope.mjs import-rules preview --file budget.json --rows '[{"key":"row:0","payee":"SHOP","amount":-20,"account":"bank"}]'
node bin/bunvelope.mjs import-rule update --file budget.json --id RULE_ID --fields '{"enabled":false}'
node bin/bunvelope.mjs import-rule delete --file budget.json --id RULE_ID
```

Replace `RULE_ID` with the id from create/list and `bank` with the selected
import account id (preview source-row accounts are literal ids). Rule condition
accounts and action envelopes are schema references and accept names. Omitting
an envelope action leaves it unchanged; `"envelope":null` explicitly suggests
Unassigned. A supplied conditions/actions object in update replaces that whole
object. An unavailable rule can still be disabled or deleted.

Preview's `context` can be passed unchanged as `transaction import`'s optional
`--expected-import-context`. The command refuses `import_review_changed` if
rules, aliases or entity availability changed since review. It does not apply
rules to your approved transaction inputs. Refresh and review before retrying.


### Forecast input evidence

`forecast readiness` is read-only. It reports account ledger dates and recorded
reconciliation checkpoints, unusable scheduled inputs, estimate classifications
from the actual simulation, and growth/contribution sources. These dates do not
prove bank statement coverage or detect income, bills or transfers never entered.

```bash
node bin/bunvelope.mjs help forecast readiness
node bin/bunvelope.mjs forecast readiness --file /tmp/bunvelope-readiness.json --date 2026-10-09
node bin/bunvelope.mjs forecast readiness --file /tmp/bunvelope-readiness.json --months 12 --contribution history --exclude-accounts '["bank"]'
```

The file is a portable budget bundle. `--what-if` selects a saved scenario for
estimate evidence; comparison and account assumption rows remain explicitly
base-plan. Account overrides follow `forecast simulation`. Exclusions filter
comparison totals, while account evidence and funding dependencies remain visible.
`--contribution` describes extrapolation after the simulation; it does not change
the near-term forecast's source. The response gives exclusive starts and inclusive
ends for the history and plan comparison windows. Historical averages use the full
reported window even when ledger history is sparse. Responses are detached from
cached forecast data and cannot save or repair anything.
