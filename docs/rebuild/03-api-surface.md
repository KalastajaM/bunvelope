# Bunvelope v2 — API Surface

The command and query registry **is** the product. Every adapter — web UI, CLI,
MCP server, HTTP — is generated from or wired directly to this one surface. If a
capability is not here, no adapter has it.

See `00-architecture.md` §3 for the contracts. This document is the registry.

---

## 1. Conventions

**Naming.** Dotted, noun-first, verb-last: `transaction.record`,
`envelope.archive`, `occurrence.settle`. The noun path mirrors the domain model,
so `--help` output, MCP tool listings and the UI's information architecture all
agree without being separately designed.

**Every command is pure.** `execute(snapshot, input, ctx) → Result<{ops, value}>`.
It never writes. The runtime commits. Consequences: dry-run, undo, and AI
proposal review are properties of the architecture rather than features.

**Every query is pure.** `run(snapshot, input, ctx) → O`.

**Lens is explicit.** Any query whose answer depends on which transactions are
counted takes `lens: 'today' | 'booked' | 'forecast'` and, for `forecast`, a
`horizon`. There is no ambient default.

> ⚠️ **DIVERGES FROM v1** — v1 reads the lens from preferences inside a wrapper,
> and 89 call sites bypass it and read the raw transaction array anyway. Two
> surfaces then report different numbers under the same label — which is the
> exact bug the lens was introduced to fix.

**Ids are supplied by the runtime**, never by the caller, via `ctx.newId()`.
Commands that create an entity return its id in `value`.

**Money crosses the boundary as minor units.** Inputs accept an integer cents
value or a decimal string (`"12.50"`); never a float. Outputs are always integer
cents plus a `currency` field. Formatting is an adapter concern.

**Errors are `{code, params}`.** Never a thrown string, never a display sentence.

---

## 2. Commands

### 2.1 Budget and settings

| Command | Input | Notes |
|---|---|---|
| `budget.create` | `{name, currency, locale?}` | Emits initial settings ops |
| `budget.rename` | `{name}` | |
| `budget.import` | `{bundle}` | Restores an exported bundle into an empty store. Rejected with `import.store_not_empty` if the store already holds data — it is a restore path, not a merge. The paired `budget.export` is a **query** (§3.10) — it writes nothing. |
| `settings.update` | `{currency?, locale?, emergency?, calendarId?}` | Partial patch |

### 2.2 Categories

Categories are first-class in v2.

> ⚠️ **DIVERGES FROM v1** — v1 stores a category as free text on each envelope,
> so renaming one means rewriting every envelope, there is no canonical list, and
> ordering has nowhere to live. `category` is additionally overloaded in v1 to
> mean stress categories and invariant categories — three meanings for one word.

| Command | Input |
|---|---|
| `category.create` | `{name, after?}` |
| `category.rename` | `{id, name}` |
| `category.reorder` | `{id, after \| null}` |
| `category.archive` | `{id}` |

### 2.3 Envelopes

| Command | Input | Notes |
|---|---|---|
| `envelope.create` | `{name, categoryId, rollover?, goal?, after?}` | |
| `envelope.update` | `{id, name?, categoryId?, description?}` | |
| `envelope.setRollover` | `{id, policy}` | `carry \| cover-from-unallocated \| zero-monthly` |
| `envelope.setGoal` | `{id, amount, date}` | |
| `envelope.clearGoal` | `{id}` | |
| `envelope.reorder` | `{id, after \| null}` | Array order is display order |
| `envelope.archive` | `{id}` | Always allowed |
| `envelope.unarchive` | `{id}` | |
| `envelope.delete` | `{id}` | **Rejected** with `envelope.in_use` if any posting, plan item or template line references it. A setting referencing the envelope does not block the delete — `settings.emergencyEnvelopeId` is `SET NULL` (`01-domain-model.md` §2) |

**`slug` and `sortKey` are never caller-supplied.** `envelope.create` derives
`slug` from `name` (slugify, with a numeric suffix on collision — the v1
`uniqueId` behaviour, now enforced rather than advisory). `sortKey` places the
new envelope last in the collection unless `after?` names the envelope it
should follow, in which case it is assigned to sort immediately after that one.
The same two rules apply to every other `create` command below that produces a
`slug` or a `sortKey`.

### 2.4 Accounts

| Command | Input | Notes |
|---|---|---|
| `account.create` | `{name, type, openingBalance, interestTiers?, after?}` | `type` is **required**. `slug`/`sortKey` derivation follows the rule stated in §2.3 |
| `account.update` | `{id, name?, notes?, interestTiers?, ...}` | |
| `account.reorder` | `{id, after \| null}` | |
| `account.archive` / `account.unarchive` | `{id}` | |
| `account.delete` | `{id}` | Rejected with `account.in_use` if referenced |

### 2.5 The ledger

`transaction.record` is the single write path for the ledger. All user-facing
"types" are postings shapes on one command.

```ts
transaction.record({
  date:     PlainDate,
  payee:    string,
  note?:    string,
  label?:   TxLabel,        // presentation only: expense | income | account-transfer | envelope-transfer | …
  postings: Posting[],      // must balance — see 01-domain-model.md §3.5
  status?:  'posted' | 'pending',   // default 'posted'
  source?:  Source,
  // mirrors 01-domain-model.md §3.5. Present iff the transaction records an
  // investment event; validation checks direction against that direction's
  // posting shape in 02-business-rules/02-postings-and-balances.md §1 —
  // buy/sell postings touch the investment account, a dividend's do not
  // (cash + envelope only), an adjust carries only its zero bucketing leg.
  // Absent the group, postings on an investment account are ordinary money
  // movement — account transfer, adjustment, reconcile (§2.10) — legal per
  // the same table, and move no units.
  investment?: {
    symbol:       string,
    direction:    'buy' | 'sell' | 'dividend' | 'adjust',
    units:        Decimal,
    pricePerUnit: Cents,
    fee:          Cents,
  },
}) → { id: TransactionId }
```

> ⚠️ **DIVERGES FROM v1** — v1 has eight transaction types with overlapping
> optional field sets (`account`, `from_account`, `envelope_id`,
> `envelope_splits`, `lines`, `target_id`, `from_envelope_id`) and a per-type
> sign rule, which produced ~10 "convention drifted" incidents. It also has
> **seven distinct code paths that create a transaction**, whose record shapes
> disagree — one omits `status` where another sets it, two adjustment writers
> disagree on whether `payee` is `null` or absent. In v2 there is one path.

| Command | Input | Notes |
|---|---|---|
| `transaction.record` | above | Rejected if postings don't balance |
| `transaction.amend` | `{id, ...patch}` | Same validation as record |
| `transaction.delete` | `{id}` | Recoverable via the op log |
| `transaction.setCleared` | `{id, cleared}` | Reconciliation state, orthogonal to `status` |
| `transaction.setFlagged` | `{id, flagged}` | |
| `transaction.bulkAssignEnvelope` | `{ids[], envelopeId}` | |
| `transaction.bulkSetDate` | `{ids[], date}` | |
| `transaction.bulkSetPayee` | `{ids[], payee}` | |
| `transaction.bulkDelete` | `{ids[]}` | One atomic op batch |
| `transaction.mergeToTransfer` | `{ids: [a, b]}` | Two opposite-signed rows on different accounts become one transfer; rejected otherwise |

### 2.6 Allocation

| Command | Input | Notes |
|---|---|---|
| `allocation.fill` | `{date, lines: [{envelopeId, mode: 'add'\|'set', amount}], sourceAccountId?}` | `sourceAccountId` set ⇒ the fill also debits that account (new income) |
| `allocation.applyTemplate` | `{templateId, date, scale?}` | Resolves template lines, then behaves as `allocation.fill`. `scale` defaults to `1` |
| `allocation.zeroOut` | `{date}` | Sweeps `unallocated` to zero |
| `allocation.consolidate` | `{envelopeId, date}` | Sweeps one envelope's surplus/gap to zero |

**`scale` applies after each line is resolved to a delta**, `set`-mode included
(below). A fixed-amount delta is multiplied by `scale` and rounded half-to-even
to the cent. A `percent-of-plan` line is **not** scaled — it already scales
with its basis, so scaling it again would double-apply the factor — and a
`goal-required` line is **not** scaled — a funding requirement is a
requirement, not a proportion of one. `scale` defaults to `1`, which is a
no-op.

**`mode: 'set'` is resolved to a delta at write time.** The command reads the
balance as of `date`, computes `target − current`, and stores a plain delta. No
stored line ever overwrites a balance.

> ✅ **v1 already does this for hand fills** (`js/pages/fill-line.js`) and, as
> of `535e5c8`, for apply-to-pool. ⚠️ **But not for scheduled template fills**
> — `liveTemplateLines` still preserves `mode: 'set'` into every scheduled
> fill, and that path is the hard one: a future-dated `set` can only be
> resolved inside the projection walk. Resolving at the single command
> boundary — and making scheduled lines `add`-only by construction — is what
> makes the whole class impossible rather than fixed path by path.
>
> The stored ledger is then order-independent by construction, which retires an
> invariant no row-level function can enforce — and removes `set`-mode
> special-casing from the balance walk, the fill display total, the
> `fillSource` classification and the template funding-source rule.

**Settled (2026-08-27): the intent is kept as an engine-blind annotation.**
Resolving to a delta loses the record that the user said *"set to 250"* rather
than *"add 130"*, and two real surfaces want it back: the fill editor's
round-trip and "explain this transaction". So the stored line carries
`enteredAs: { mode: 'set', target }` (`01-domain-model.md` §3.5), under three
guardrails that make "non-authoritative" enforced rather than hoped:

1. **Lint-enforced blindness** — no engine path may read `enteredAs` (the same
   path-restriction layer as every other rule in `00-architecture.md` §7).
2. **A property test** (`04-invariants-and-proof.md` A10) — mutating or
   stripping `enteredAs` across a generated ledger changes **no** balance,
   projection or report.
3. **Copy discipline** (`07-ui-spec.md`) — it renders as a statement about the
   *input* ("entered as: set to €250"), never about the ledger. The target was
   true only at resolution time; amending earlier history makes
   `target − priorBalance ≠ delta`, and only the past-tense phrasing stays
   true forever.

The deciding factor, recorded for re-derivation: the annotation's risk — a
stored `set` shape being read by future balance code, resurrecting the
order-dependence family — is fully neutralised by machinery the architecture
already pays for. If either guardrail were expensive, dropping the annotation
would have won.

### 2.7 Plan

| Command | Input | Notes |
|---|---|---|
| `plan.item.create` | `{envelopeId, kind, amount, schedule, accountId?, buffer?, paymentDay?, dayType?, include?, includeInEmergency?, recurring?, activeFrom?, activeUntil?, stressCategory?}` | All seven flag fields are required on the entity (`01-domain-model.md` §3.6) but optional here, defaulting to: `buffer: 0`, `paymentDay: 0`, `dayType: 'exact'`, `include: true`, `includeInEmergency: false`, `recurring: true`, `activeFrom: null`, `activeUntil: null`, `stressCategory: 'Z'` (the domain doc's own default — "never cut") |
| `plan.item.update` | `{id, ...patch}` | |
| `plan.item.delete` | `{id}` | Cascades to stored `skipped` occurrences; `RESTRICT` on `settled` ones. Pending occurrences are virtual (`01-domain-model.md` §3.7) |
| `plan.item.setRecurring` | `{id, recurring: boolean, accountId?, dayType?}` | |
| `plan.item.setStress` | `{id, category, cuts?}` | See `02-business-rules/03-planning-and-policies.md` §12 |

> ⚠️ **DIVERGES FROM v1** — v1 refuses to store an account on a plan item unless
> it is also auto-scheduled, which forces the forecast to *infer* an account from
> spending history. In v2 `accountId` is independent of `recurring`.

### 2.8 Occurrences

First-class in v2. This is the highest-value modelling change in the rebuild.

| Command | Input | Notes |
|---|---|---|
| `occurrence.materializeDue` | `{asOf}` | Idempotent. Emits transactions for due occurrences and links them. |
| `occurrence.post` | `{id, date?, accountId?}` | Post one occurrence now |
| `occurrence.settle` | `{id, transactionId}` | Link an existing hand-entered payment. Writes the transaction's amount onto the occurrence record — the stored record thereafter reports what was actually paid, not the plan cell (`02-business-rules/01-calendar-and-scheduling.md` §2.2 step 3) |
| `occurrence.unsettle` | `{id}` | |
| `occurrence.skip` | `{id, reason?}` | Replaces v1's tombstone array entirely |

> ⚠️ **DIVERGES FROM v1** — v1 has no occurrence entity. A bill is a derived
> `(itemId, month)` tuple encoded into a mutable string on whichever transaction
> settled it, so "counted exactly once" is reconstructed by fuzzy matching in
> three independent implementations. Deleting the transaction deletes the only
> record that the occurrence was handled, which is why a parallel tombstone array
> exists in the metadata document with no schema and no validation. In v2 these
> are foreign keys and a status field.

### 2.9 Templates

| Command | Input |
|---|---|
| `template.create` | `{name, lines[], schedule?, sourceEnvelopeId?}` |
| `template.update` | `{id, ...patch}` |
| `template.delete` | `{id}` |

> ⚠️ **DIVERGES FROM v1** — v1 has two template species (`manual` with fixed
> amounts and `dynamic` with percent-of-plan assignments), each with its own
> editor, its own math and a one-way "you cannot convert between types later"
> warning. v2 has one shape: a line carries either a fixed amount or a
> percentage-of-plan rule, and a template may mix them.

### 2.10 Reconciliation

```ts
account.reconcile({
  accountId, statementDate, statementBalance,
  clearedIds:   TransactionId[],
  adjustment?:  { amount, envelopeId? },   // omit to leave a gap unreconciled
}) → { difference: Cents }
```

One atomic command rather than a modal session: it marks rows cleared, optionally
emits the gap adjustment, and stamps the account — all in one op batch, all
dry-runnable.

> ⚠️ **DIVERGES FROM v1** — v1 has three overlapping flows on one account row
> (manual reconcile, an investment "update value" dialog that produces the same
> adjustment type but skips the clearing bookkeeping and never stamps the
> account, and an AI reconcile sheet whose apply path is partly inert — with no
> transaction id it toasts "applied" and does nothing).

### 2.11 Import

`import.plan` is a **query** (§3.9) — it returns a proposal and writes nothing.

| Command | Input | Notes |
|---|---|---|
| `import.commit` | `{rows[], accountId, mappingId?}` | Approved rows only |
| `import.saveMapping` | `{name, columns}` | Reusable column mapping |

### 2.12 Investments

| Command | Input | Notes |
|---|---|---|
| `price.record` | `{symbol, price, asOf}` | **Appends** a price point — `prices` is history, never overwritten (`01-domain-model.md` §3.9). Manual entry and the sidecar's price fetch (`00-architecture.md` §9.1) both land here. |
| `holding.override` | `{accountId, symbol, units, costBasis, reason}` | `reason` is required — `HoldingOverride` has no optional fields (`01-domain-model.md` §3.9) |
| `holding.clearOverride` | `{accountId, symbol}` | |
| `payee.setRule` | `{payeeKey, envelopeId?, symbol?}` | Generalises v1's `investment.mapPayee` — one memory for categorisation and symbol mapping (`02-business-rules/03-planning-and-policies.md` §13) |

> ⚠️ **DIVERGES FROM v1** — v1 keeps `manualRows` inside the metadata document:
> a second, hidden transaction ledger invisible to every query, filter, report,
> invariant check and AI tool. In v2 a manual correction is an ordinary posting
> with `source: 'manual-correction'`.

### 2.13 History

| Command | Input | Notes |
|---|---|---|
| `history.undo` | `{}` | Emits inverse ops for the last user batch |
| `history.redo` | `{}` | |

Free consequence of the op log (inverse ops are computed and stored at commit
time — `06-change-log.md` §1). v1 has no *general* undo — only six ad-hoc
toast-level undo affordances on delete/archive flows, each hand-rolled.

### 2.14 Review months

| Command | Input | Notes |
|---|---|---|
| `review.closeMonth` | `{month}` | Marks the month closed (`settings.closedMonths`); a closed month is read-only advice to adapters — the ledger itself stays editable, and the review renders the month as settled |
| `review.reopenMonth` | `{month}` | |

### 2.15 Banking calendars

Calendars are user-editable (README settled question 2): a user may override a
built-in calendar or add their own, and choose which one applies via
`settings.calendarId` (§2.1). See `01-domain-model.md` §3.10 and
`02-business-rules/01-calendar-and-scheduling.md` §1.

| Command | Input | Notes |
|---|---|---|
| `calendar.upsert` | `{id, name, weekend?, holidays}` | Adds a user calendar, or overrides a built-in of the same `id` — a record in `bankingCalendars` shadows the built-in. Shape mirrors `BankingCalendar` (`02-business-rules/01-calendar-and-scheduling.md` §1.1) |
| `calendar.delete` | `{id}` | User-defined only. Rejected with `calendar.builtin` for a built-in id, or `calendar.in_use` if it is `settings.calendarId` |

---

## 3. Queries

### 3.1 Balances

| Query | Input | Returns |
|---|---|---|
| `envelope.balances` | `{lens, horizon?, asOf?}` | `Map<EnvelopeId, Cents>` |
| `account.balances` | `{lens, horizon?, asOf?}` | `Map<AccountId, Cents>` |
| `account.runningBalance` | `{accountId, lens, from, to}` | Dated series |
| `budget.unallocated` | `{lens, horizon?}` | `Cents` |
| `budget.savingsSplit` | `{lens}` | Operational vs savings vs investment |
| `account.projectedInterest` | `{accountId}` | Marginal tiered annual interest (`02-business-rules/02-postings-and-balances.md` §7) |

**Both sides of `unallocated` must be read through the same lens.** It is
`accounts − envelopes`; a mixed pair stops reconciling, which is the one thing
the figure exists to do.

### 3.2 Ledger

| Query | Input | Returns |
|---|---|---|
| `transaction.list` | `{filter, lens, horizon?, cursor?, limit?}` | `{actual[], projected[], nextCursor?, total}` |
| `transaction.get` | `{id}` | `Transaction` |
| `transaction.dayTotals` | `{from, to, lens}` | Net movement per day |

**`transaction.list` returns actual and projected as separate arrays.**

**Pagination is cursor-based.** `cursor?: string` resumes after the last row of
a previous page; `limit?: number` caps the page size (default `100`, max
`500`). The result carries `nextCursor?: string` — present iff more rows
follow — and `total: number`, the full count under `filter` and `lens`
independent of paging.

**The `filter` object is closed and specified here**, not ad hoc per adapter:

```ts
type TxFilter = {
  text?:        string                 // payee + note substring
  tags?:        string[]               // exact tag match (02-…-balances.md §6)
  envelopeId?:  EnvelopeId
  accountId?:   AccountId
  label?:       TxLabel
  status?:      'all' | 'posted' | 'pending'   // the transaction's own status
  cleared?:     boolean                        // reconciliation flag, orthogonal to status
  flaggedOnly?: boolean
  from?:        PlainDate
  to?:          PlainDate
  amount?:      { op: '<' | '<=' | '=' | '>=' | '>', value: Cents }
}
```

The adapter's search *syntax* — `#tag`, `>50`, date presets — parses into this
object; the grammar lives in the adapter, the semantics live here, and every
adapter's search means the same thing.

> ⚠️ **DIVERGES FROM v1** — v1 filters on a four-way, non-orthogonal muddle —
> `status`, `cleared`, `is_forecast`, and a `scheduled` flag nothing ever sets
> (`00-architecture.md` §4). `status?: 'scheduled'` on a filter object is the
> same conflation: it asks the ledger's `posted | pending` axis a question
> phrased in the retired vocabulary, with no way to filter posted vs pending at
> all. v2's `TxFilter` has the two orthogonal fields the domain model
> actually has — `status` and `cleared` — and nothing else.

> ⚠️ **DIVERGES FROM v1** — v1 merges generated forecast rows into the same array
> as real ones and relies on every consumer filtering `is_forecast`. This is the
> structural root of the double-counting family, and the function that assembles
> that merged list is a closure inside a page with no unit test.
>
> `dayTotals` must net across accounts, not sum display amounts. In v1 a day
> holding one €400 own-account transfer read **+€400** — summing per-row display
> amounts treats every non-expense as a credit, producing a number that is not a
> quantity of anything.

### 3.3 Occurrences

| Query | Input | Returns |
|---|---|---|
| `occurrence.list` | `{from, to, status?}` | `Occurrence[]` |
| `occurrence.due` | `{asOf}` | Due and unsettled |
| `occurrence.unlinked` | `{asOf, window?}` | **Assistive** suggestions pairing untagged payments to unsettled occurrences |

`occurrence.unlinked` is a suggestion surface only. It is never the correctness
mechanism — that is the `settledBy` foreign key.

> ⚠️ **DIVERGES FROM v1** — in v1 the fuzzy matcher *is* the correctness
> mechanism, which is why it needed a repair sheet, a stale-link dialog, two
> invariant categories and five consecutive bug fixes.

### 3.4 Plan and review

| Query | Input | Returns |
|---|---|---|
| `plan.annual` | `{year}` | Income vs expense totals, by envelope |
| `plan.monthly` | `{month}` | Required monthly funding per envelope |
| `plan.calendar` | `{from, to}` | Expected expenses by date |
| `review.month` | `{month, lens}` | The full review table (see `02-business-rules/03-planning-and-policies.md` §8) |
| `emergency.requirement` | `{}` | Essentials × duration − covered |
| `stress.scenarios` | `{}` | Per-scenario income / expense / net / runway (`02-business-rules/03-planning-and-policies.md` §12) |

### 3.5 Projection

| Query | Input | Returns |
|---|---|---|
| `envelope.projection` | `{envelopeId, months, asOf}` | Daily series + low/high/closing |
| `envelope.recommendations` | `{envelopeId, projection}` | `{code, params, suggestedAmount, unit}[]` |
| `envelope.spare` | `{envelopeId, asOf}` | Headroom before projecting below floor |

**Recommendations carry a declared unit.**

> ⚠️ **DIVERGES FROM v1** — v1 recommendations are bare numbers, which is how a
> search bounded by a *balance* while solving for a *per-month rate* produced a
> recommendation to set a monthly fill to −€49,200. A declared unit plus a
> property asserting that applying the recommendation produces the stated effect
> makes that class uncompilable and untestable-because-impossible.

### 3.6 Reports

`report.spendingByEnvelope`, `report.spendingByMonth`, `report.payees`,
`report.incomeVsSpending`, `report.savingByMonth`, `report.envelopeBalances`,
`report.allocation`, `report.netWorthByMonth` — each takes `{from, to, lens}`.

All return **codes and numbers only**.

> ⚠️ **DIVERGES FROM v1** — v1 report aggregates embed hardcoded chart hex
> colours and English display strings (`'(Unknown)'`, `'(no payee)'`,
> `` `Other (${n})` ``) in engine output. v2 returns `{code, params, value}` and
> the adapter renders.

### 3.7 Dashboard and health

| Query | Returns |
|---|---|
| `dashboard.summary` | The KPI set, computed **once** and shared |
| `holdings.list` | Derived positions, overrides applied |
| `invariants.check` | `{code, params, entityId}[]` |

**`dashboard.summary` is enumerated, not vague**: unallocated / left-to-assign
state, spent-this-month (with days remaining), total balance with the
cleared-vs-displayed delta, the savings split (incl. unrealized P&L),
**credit-cards-to-pay** (computed payment due — easy to lose, do not),
Age of Money with drop attribution, and the money cushion. Every panel on the
dashboard reads from this one query.

> ⚠️ **DIVERGES FROM v1** — v1's dashboard donut and trend compute "spent"
> independently of the KPI beside them and include scheduled rows where the KPI
> does not, so the same month reads differently on the same screen. In v2 every
> panel on a screen reads from one query.

`invariants.check` exists in v2 as an **import and migration tool**, not as a
permanent UI fixture. In steady state it must always return empty, because the
schema makes violations unrepresentable — and a debug build asserts exactly that
after every commit.

### 3.8 History

`envelope.history`, `ageOfMoney`, `ageOfMoney.history`, `moneyCushion` — carried
over from v1's algorithms (see `02-business-rules/`, in particular
`02-business-rules/04-forecast-and-history.md` §6 for Age of Money), subject to the
whole-calendar-day span rule in `00-architecture.md` §6.

### 3.9 Import

```ts
import.plan({ rows, accountId, mapping }) → {
  proposed: DraftTransaction[],
  duplicates: { rowIndex, transactionId, confidence }[],
  statementCheck?: { expected, computed, difference },
}
```

Pure. Writes nothing. The adapter presents it; `import.commit` applies the
approved subset.

Rows arrive from the CSV parser (auto separator/column detection, saved
mappings, Windows-1252 fallback — all carried from v1) **or from the AI
`parse_document` intent** (`00-architecture.md` §9.1) for receipts, PDF
statements and unparseable CSVs. `import.plan` pre-assigns envelopes from
`payeeRules` deterministically before any model-based categorisation, and
grades duplicates exact / good / possible with one-to-one claiming, as v1
does.

### 3.10 Export

```ts
budget.export({}) → Bundle    // snapshot + op log, versioned, self-describing
```

A query — it writes nothing; the adapter turns the bundle into a file. With
`budget.import` (§2.1) this is the backup, portability and
disaster-recovery story, which for a local-only app is **not optional**: the
user is their own DBA, and the UI spec (`07-ui-spec.md`) requires the adapter
to offer periodic export as a safety net.

### 3.11 Entity reads

Plain reads over each collection. The web UI can reach the same data through
`subscribe` on the in-process snapshot (`00-architecture.md` §3.4), but the CLI
and MCP server exist only through this registry (§4.1, §4.2) — without these,
neither could list the user's envelopes or accounts, let alone resolve a
`--envelope` flag to an id. Every `.list` query defaults to live entities only.

| Query | Input | Returns |
|---|---|---|
| `category.list` | `{includeArchived?}` | `Category[]` |
| `envelope.list` | `{includeArchived?}` | `Envelope[]` |
| `envelope.get` | `{id}` | `Envelope` — `envelope.not_found` if `id` doesn't resolve |
| `envelope.resolve` | `{name}` | `{id: EnvelopeId}` — exact name match, else an unambiguous prefix match, else `envelope.ambiguous` naming the candidates |
| `account.list` | `{includeArchived?}` | `Account[]` |
| `account.get` | `{id}` | `Account` — `account.not_found` if `id` doesn't resolve |
| `template.list` | `{}` | `Template[]` |
| `template.get` | `{id}` | `Template` — `template.not_found` if `id` doesn't resolve |
| `plan.item.list` | `{envelopeId?}` | `PlanItem[]` |
| `plan.item.get` | `{id}` | `PlanItem` — `plan.item.not_found` if `id` doesn't resolve |
| `settings.get` | `{}` | `Settings` |
| `calendar.list` | `{}` | `BankingCalendar[]` — built-ins plus any user overrides/additions from `bankingCalendars` |
| `calendar.get` | `{id}` | `BankingCalendar` — `calendar.not_found` if `id` doesn't resolve |

**`envelope.resolve` is what turns a name into an id** for the CLI and MCP
adapters (`--envelope groceries`), so a typo is a reported error rather than a
silently-null reference. Ids are otherwise always supplied by the caller (§1)
— resolving one from a name is this query's whole job.

---

## 4. Adapters

### 4.1 CLI

Generated from the registry. One verb per command and query.

```
bunvelope tx record --date 2026-08-26 --payee "K-Market" \
                    --amount 42.10 --envelope groceries --account checking

bunvelope envelope balances --lens forecast --horizon 3m --json
bunvelope occurrence due --as-of today
bunvelope allocation fill --template salary-split --date 2026-09-01 --dry-run
```

- `--json` on any command or query emits machine-readable output.
- `--dry-run` on any command prints the ops it *would* commit and exits 0.
- Exit codes: `0` success, `1` domain error (with `code` on stderr as JSON),
  `2` usage error.

Because the CLI is generated, scheduled surfaces come free: `bunvelope
occurrence due --json` in a cron job **is** the bill-reminder feature — pipe
it to a desktop notifier and local-only has reminders no v1 mode had.

### 4.2 MCP server

One tool per command and query. `inputSchema` is generated from the same schema
that produces the TypeScript types and the CLI flags.

Design rules that make it actually usable by a model:

- **`summary` is the tool description.** Write it for a reader who cannot see the
  codebase: what the tool does, when to use it, and what it returns. This is the
  single highest-leverage field in the whole registry.
- **Queries are exposed freely; commands are gated.** A command tool returns its
  ops as structured content and does **not** commit. Committing is a separate,
  explicit step the human approves. This is the v1 "the model cannot write"
  property, obtained structurally.
- **Ids in, ids out.** Never let the model invent an id. Resolution from a name
  to an id is its own query (`envelope.resolve`), so a wrong name is an error
  rather than a silently-null reference.
- **Amounts as decimal strings** in tool inputs, converted at the boundary.
  Models are unreliable with float arithmetic and reliable with strings.
- **Errors are returned as `{code, params}`**, not prose, so a model can branch
  on them.

Scope the exposed set deliberately. A first cut: all read queries, plus
`transaction.record`, `transaction.amend`, `allocation.fill`,
`occurrence.settle`, `occurrence.skip`, and `import.commit`. Destructive and
configuration commands stay out until there is a reason.

Transport and the commit gate are security surface: the server is
stdio-first, the approval step is rendered by a trusted Bunvelope process
(never the MCP host's tool-call prompt), and the first-cut set above is a
ceiling until widening is a recorded decision — `08-security.md` §3–§4
(SEC5–SEC9).

The AI sidecar's own surface — the four intents including `parse_document`
(which feeds `import.plan`), the insight cards, and the price proxy — is
specified in `00-architecture.md` §9.1.

### 4.3 Web UI

Imports `Session` directly — no serialization, no HTTP. Every displayed number
comes from a query; no view computes money inline.

### 4.4 HTTP

Only when cloud sync arrives. `POST /command/:name`, `POST /query/:name`, plus
the sync endpoints in `06-change-log.md`. The same registry, a different
envelope.

---

## 5. What the registry deliberately omits

Scope discipline lives here: if it is not a command or a query, no adapter can
do it.

Nothing in the registry supports the v1 repair sheet, the stale-link resolution
dialog, tombstones, or a permanent invariant console. **Those are not features —
they are compensations for model weaknesses this design removes.** If any of
them still seems necessary during the build, the model is still wrong and should
be fixed rather than compensated for.

Two deliberate retirements and one reclassification, distinct from the above:

- **The Goodbudget importer is retired** (decided 2026-08-27 — no longer
  used; generic CSV plus the AI `parse_document` intent cover the need).
- **The setup wizard is not a registry concern — but it is not a
  compensation either.** Its job — name the budget, create accounts, paste
  opening balances — is ordinary adapter UX over `budget.create`,
  `account.create` and adjustment postings. It is onboarding, it carries
  forward, and it lives in `07-ui-spec.md` as a flow rather than a command.

---

## 6. Error catalogue

**The catalogue lives in the registry, beside the commands and queries it
covers — not in a separate document.** It is one flat, namespaced list of
`{code, params}` shapes — `<noun>.<reason>`, mirroring the naming convention in
§1 — and every command or query's declared failures (the "Notes" column above)
name a code from it. Every adapter maps from this same list: the CLI's exit-1
JSON (§4.1), the MCP structured error content (§4.2), and the web UI's toast
copy all resolve the same `code` to their own presentation, which is what
`00-architecture.md` §3.3 means by "the same catalogue the UI uses."

The list is **open-ended** — a new command earns a new code the same way it
earns a new registry entry, not by reusing a near-enough one. Codes named
elsewhere in this document set so far:

| Code | Where |
|---|---|
| `envelope.in_use` | §2.3 |
| `envelope.not_found` | §3.11 |
| `envelope.ambiguous` | §3.11 |
| `account.in_use` | §2.4 |
| `account.not_found` | §3.11 |
| `template.not_found` | §3.11 |
| `plan.item.not_found` | §3.11 |
| `calendar.not_found` | §3.11 |
| `calendar.builtin` | §2.15 |
| `calendar.in_use` | §2.15 |
| `calendar.no_working_day` | `02-business-rules/01-calendar-and-scheduling.md` §1.7 |
| `plan.unpostable` | `02-business-rules/01-calendar-and-scheduling.md` §3.2 — an `invariants.check` category surfaced in `occurrence.materializeDue`'s result, not a command failure |
| `import.store_not_empty` | §2.1 |
