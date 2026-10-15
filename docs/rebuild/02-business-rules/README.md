# Bunvelope v2 — Business Rules

The algorithms, stated for reimplementation without reading v1 source.

**Normative.** Where v1's behaviour is a defect, the correct behaviour is stated
and the divergence marked with `⚠️ DIVERGES FROM v1`. See `../00-architecture.md`.

| Doc | Contents |
|---|---|
| `01-calendar-and-scheduling.md` | Banking calendar, occurrence generation, materialisation |
| `02-postings-and-balances.md` | The sign rules, balance walks, spend, holdings, invariants |
| `03-planning-and-policies.md` | Annual plan, funding math, emergency fund, rollover, goals |
| `04-forecast-and-history.md` | Projection, netting, recommendations, Age of Money, reports |

---

## Cross-cutting rules

These bind every algorithm in this directory.

### R1 — Dates are ISO strings, compared lexicographically

`PlainDate` is `YYYY-MM-DD`. Every comparison is a string compare. Every
*arithmetic* operation goes through the single date module.

Local-calendar formatting only. **Never** derive a calendar date from
`Date.prototype.toISOString()` — it converts to UTC and lands on the previous
day for anyone east of Greenwich. `toISOString()` is correct only for
`createdAt`/`updatedAt` instants.

Whole-day spans use a calendar-day difference (`Date.UTC(y,m,d)` triples,
differenced, divided), never a raw millisecond division. A raw ms diff is a day
short across spring-forward and an hour long across fall-back, and
`floor`/`ceil` then round the wrong way exactly at the boundary.

> ⚠️ **DIVERGES FROM v1** — v1 runs three incompatible date models side by side.
> `filterTransactions` and the sorts are lexicographic; `computeDashboardSummary`
> buckets months through a local `Date`; `validateTxDate` round-trips through
> local `new Date(y, m-1, d)`. v1's `parseDate` also accepts `dd/mm/yy`, so a row
> the date validator **rejects** can still be bucketed by the dashboard.

### R2 — A transaction with no date is rejected at the boundary

> ⚠️ **DIVERGES FROM v1** — in v1 `''` sorts before every real date and the
> `asOf` filter *skips* rows with no date entirely. A `set`-mode fill with no
> date is therefore applied before everything else and survives every cutoff.
> The validator flags it; the balance is already wrong.

### R3 — Money is integer minor units; rounding is not a strategy

`Cents` is `bigint`. There is no accumulation of floats and therefore no
`round2` at boundaries, no half-cent epsilon comparisons, and no residual cent
that no transaction explains.

Where a v1 algorithm below specifies `round2(x)` or a `0.005` threshold, the v2
equivalent is exact integer arithmetic. **Division is the only place rounding
enters**, and every division states its rounding mode explicitly (see
`calcDepositAndRequired`, which rounds the level deposit *up*).

**Default rounding mode.** Unless a rule states otherwise, every money
division rounds half-to-even to the cent. The default is a safety net for
divisions nobody has flagged yet — it does not excuse a known site from
stating its mode inline; every division named elsewhere in this directory
still says so explicitly.

### R4 — The clock and the id generator are required parameters

No engine function defaults `today` to now, and none falls back to a
time-plus-random id.

> ⚠️ **DIVERGES FROM v1** — 13 exported functions default `today`/`refDate` to
> `new Date()`, and three `idGen` parameters silently fall back to
> `Date.now() + Math.random()`. A caller that forgets gets nondeterminism with
> no error, and the tests cannot pin it.

### R5 — Engine functions return codes, never display strings

Every user-facing label is `{ code, params }`, resolved by the adapter.

> ⚠️ **DIVERGES FROM v1** — English strings are returned from engine functions
> in at least five places, and **written into persisted records** in two:
> rollover adjustments store `payee: 'Rollover: sweep to unallocated'` and
> template fills store `'Template allocation'`. Worse, `runMonthlyReview`
> fabricates `` `(deleted: ${id})` `` as an envelope name and a page then
> *filters on that string* — the display text has become a protocol. v2 returns
> a structural `missing: true` flag and the raw id.

### R6 — No function mutates its arguments

> ⚠️ **DIVERGES FROM v1** — the netting pass mutates `row.amount` in place and
> documents the precondition in a docblock. An unenforceable invariant
> propagated across a module boundary is a defect, not a contract.

### R7 — One rule, one implementation

Where v1 has *n* copies of a rule, v2 has one, and the lint layer enforces the
call. Known duplications v2 must not recreate:

| Rule | v1 copies |
|---|---|
| Forecast dedup | 8 |
| Per-type envelope math | 5 (before consolidation) |
| Rollover month-end policy | 2 (`policies.js` and the projection walk) |
| Portfolio market value | 3 |
| `fmt()` | 2 |
| `isCloudMode()` | 4 |
| CSV tokenizer + amount parser | 2 |

### R8 — Every guard is total

Nullish collections, `null` entries inside arrays, and unknown enum values must
not throw and must not silently produce a wrong number.

> ⚠️ **DIVERGES FROM v1** — `computeAccountBalances(null, txs)` throws. A `null`
> entry in `tx.lines` throws on the account side while the envelope side guards
> it, so a malformed fill computes envelope balances fine and crashes account
> balances. An account id referenced by a transaction but absent from `accounts`
> silently materialises in the balance map and **shifts `unallocated`**.

### R9 — Enum values are exhaustive, and unknown values are errors

> ⚠️ **DIVERGES FROM v1** — `direction: 'adjust'` is understood by the holdings
> walker and by nothing else; the balance and envelope paths default *anything
> unrecognised* to `'buy'`. Today that is harmless only because such rows never
> reach balance code. Persist one and it silently debits the investing envelope
> and moves both accounts.

### R10 — `include` means one thing

An item is included iff `include !== false`.

> ⚠️ **DIVERGES FROM v1** — `computeAnnualTotals` tests `include` for
> *truthiness* while every sibling tests `!== false`. An item with
> `include: undefined` is therefore excluded from annual totals but included in
> the expense calendar, the buffers, the dynamic templates and the emergency
> essentials. Verified by execution.
>
> Separately: v1's materialisers ignore `include` entirely, so an item excluded
> from the budget **still auto-posts transactions**. Settled for v2 — `include`
> is a master switch and an excluded item generates no occurrences at all. See
> `01-calendar-and-scheduling.md` §7.

### R11 — A schedule cell has one decode

```ts
type ScheduleCell = { active: false } | { active: true; override: Cents | null }
```

> ⚠️ **DIVERGES FROM v1** — v1's cell is polymorphic (`true` / `false` / a
> number / absent), and **two functions decode it differently**. For a cell
> holding `null` or a non-numeric string, `computeAnnual` contributes 0 while
> `buildExpenseCalendar` contributes the full default amount. Verified by
> execution. This is a latent inconsistency, not a design.
