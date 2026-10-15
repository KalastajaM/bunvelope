# Postings &amp; Balances

Normative. Cross-cutting rules R1–R11 in `README.md` apply throughout.

---

## 1. Posting construction

The eight v1 transaction types become **posting shapes**. This table is the
complete replacement for v1's per-type sign rules, and it is the only place the
rules exist.

| Event | Account postings | Envelope postings |
|---|---|---|
| Expense | `account −A` | `envelope −A` |
| Split expense | `account −A` | one per split, `envelope −s` (**signed**: a negative line is a credit back) |
| Income | `account +A` | — (lands in unallocated) |
| Income assigned to an envelope | `account +A` | `envelope +A` |
| Account transfer | `from −A`, `to +A` | — |
| Envelope transfer | — | `from −A`, `to +A` |
| Allocation (fill) | — | one per line, `envelope +L` |
| Allocation from new income | `sourceAccount −ΣL` | one per line, `envelope +L` |
| Debt payment | `from −A`, `to +A` | `envelope −A` |
| Investment buy | `funding −A`, `investment +A` | `envelope −A` |
| Investment sell | `investment −A`, `funding +A` | `envelope +A` |
| Investment dividend | `cash +A` | `envelope +A` |
| Investment adjust | `account ±0` — a zero bucketing leg naming the holding's account; no money moves | — |
| Adjustment (account) | `account ±A` | — |
| Adjustment (envelope) | — | `envelope ±A` |

Rules that fall out of the table and must be preserved:

- **An envelope transfer never touches an account.** There is no account branch.
- **A debt payment credits the card.** Credit cards carry negative balances, so
  `to +A` moves the balance toward zero, i.e. reduces debt.
- **Investment buys and sells are cash-symmetric** — both legs move by the same
  amount. The broker fee is folded into the cash amount at entry
  (`buy: units×price + fee`, `sell: units×price − fee`) and is therefore
  absorbed by the investing envelope, not by the accounts.
- **A dividend's paying investment account does not move.** The cash came from
  outside the budget.
- **An investment adjust moves units and cost basis, never money** (§4 ADJUST).
  Its single zero-amount account posting exists so the transaction satisfies
  "postings ≥ 1" and so the holdings fold knows which account's holding to
  adjust — the fold buckets sell/dividend/adjust by source account.
- **Only an allocation funded by new income touches an account.** Every other
  allocation source is envelope-side; the money comes from unallocated.
- **The allocation's account debit is the signed sum of its lines**, not a sum of
  magnitudes — a source-funded template carries an offsetting negative line and
  that line must reduce the debit.

**What `transaction.record` actually validates.** The identity
`Σ(account) − Σ(envelope) = Δunallocated` is a **definition** — no posting set
can fail it, so "the postings must balance" is not a checkable rule (§2.3, and
`../04-invariants-and-proof.md` S2). What is validated is **shape conformance
at the input layer**: command inputs are typed per event — an expense
constructor, a transfer constructor, a fill constructor — each producing its
postings from the table above. Illegal combinations (a transfer with one leg,
an expense whose envelope legs do not sum to the account leg, a negative
magnitude) are **unrepresentable in the input**, while storage stays generic
postings and the engine still never branches on `label`.

**The credit-card stance, stated for the product.** The model treats card
spend as cash-like: an expense on a card debits the envelope immediately, and
the card's negative balance already reduces unallocated — the **pay-in-full
assumption**; the user must hold cash to cover the card. One consequence worth
documenting where users will see it: paying down a card through a budgeted
debt envelope *releases* unallocated by the payment amount, because the debt
was already counted once through the card balance. A user carrying revolving
debt therefore double-reserves it. Accepted; what would change it is a
"pre-budget debt" account flag excluded from unallocated — out of scope until
a real carried-debt user exists.

> ⚠️ **DIVERGES FROM v1** — v1 spreads this across `txAccountDelta`,
> `txEnvelopeEffect`, `txEnvelopeIds`, and a *separate inline re-implementation*
> inside `computeAccountBalances` that does not call the shared helper. The two
> account-side copies must agree and are only asserted to agree by one test. The
> engine's own source names the cost: *"there are already too many copies of
> envelope/account sign logic in this codebase, and every one of them has drifted
> at least once."* Five copies of the envelope math existed before consolidation;
> the memorable failure was a dividend booked the wrong way in exactly one.

### 1.1 `set` mode does not survive to storage

An allocation line entered as "set this envelope to X" is resolved at write time
to `X − balanceAsOf(date)` and stored as an ordinary delta. `set` is an **input
shortcut**, never a stored operation.

> ✅ **v1 ALREADY DOES THIS — on one of two paths.** `js/pages/fill-line.js`
> resolves the Fill Envelopes sheet's `set` rows to a delta and emits
> `mode: 'add'`, and its docblock names the reasoning exactly: an absolute `set`
> line "would overwrite the balance at today's date and let future rows re-apply
> on top, silently changing nothing (the delta-vs-set-ordering bug)."
>
> ⚠️ **DIVERGES FROM v1 — the fix reached the hand paths, not the scheduled
> one.** As of `535e5c8` apply-to-pool also resolves `set` to a delta
> (`js/pages/templates.js:1162`). What remains wrong is the **scheduled**
> template-fill path: `liveTemplateLines` (`js/engine/scheduling.js:750`)
> preserves `set` from the template into every scheduled fill, via the
> resolver at `js/engine/monthly-review.js:93`. And the scheduled path is the
> hard one — a future-dated `set` can only be resolved inside the projection
> walk, because only the walk knows the projected balance on that date. v2's
> answer: `set` never survives to storage, so a *scheduled* template line is
> `add`-only by construction and the unresolvable case cannot arise.
>
> This is structural mistake #3 in miniature: *a migration is not done when the
> new path exists; it is done when the old path is gone.* v2 applies the
> resolution at the single command boundary, so there is only one path.

Three consequences of a stored `set`, all of which v1 still pays for on the
template path:

1. **Every balance walk becomes order-dependent.** v1 must sort by date with a
   stable original-index tiebreaker, and documents the requirement as a caller
   obligation that no single-row function can enforce. The concrete failure: a
   future-dated expense recorded *before* an onboarding "set" fill was silently
   wiped.
2. **Folding is asymmetric and surprising**: `set 400` then `add 50` gives 450,
   but `add 50` then `set 400` gives 400 — the set *discards* the preceding
   accumulation.
3. **Display is wrong** — a set line contributes nothing to a fill's displayed
   total, so a template mixing modes shows less than it moves. (Still open in
   v1's backlog.)

It also propagates into rules that have nothing to do with fills: a single
`set` line forces an envelope's `fillSource` to `scheduled-irregular`, which
**stands down the per-month recommendations entirely**
(`04-forecast-and-history.md` §3), and it makes a template's funding-source
draw decline silently (`01-calendar-and-scheduling.md` §4.2).

Resolving at write time makes the ledger order-independent by construction,
which becomes a property test (`../04-invariants-and-proof.md` A2) rather than a
caller obligation — and removes the special-casing from four unrelated rules.

### 1.2 The unallocated envelope

A posting on the envelope axis with `targetId: null` means unallocated.

> ⚠️ **DIVERGES FROM v1** — v1 uses a magic string `'__none__'`, and treats it
> **asymmetrically**: it is dropped for expense, income and investment transfers,
> and kept as an ordinary bucket for fills, envelope transfers, debt payments and
> adjustments. Worse, the reference validator's docstring promises `__none__` is
> accepted everywhere, but two of its branches — fill lines and adjustments,
> exactly the two where the engine *keeps* it — flag it as an unknown envelope.
> So legitimate, engine-honoured data produces a spurious invariant problem.

---

## 2. Balance computation

```
envelopeBalances(txs, lens) -> Map<EnvelopeId, Cents>
  for each posting on the envelope axis of each tx in lens(txs):
      balances[targetId] += amount

accountBalances(accounts, txs, lens) -> Map<AccountId, Cents>
  seed each account with its openingBalance
  for each posting on the account axis of each tx in lens(txs):
      balances[targetId] += amount
```

**No sort is required in v2.** Every posting is a commutative signed delta —
there is no assignment operation left in the ledger (§1.1). This is the direct
payoff of resolving `set` at write time.

**Envelopes have no opening balance.** An envelope enters the map only when a
posting touches it.

**An account id that does not resolve is an error**, raised at the boundary.

> ⚠️ **DIVERGES FROM v1** — an unresolvable account id silently materialises an
> entry in v1's balance map, and that entry then flows into `unallocated`
> (it is not in the investment-exclusion set, which is built from the accounts
> array) and into the dashboard's total. **A dangling reference silently shifts
> the headline figure.** The validator reports it; the number is wrong meanwhile.

### 2.1 The lens

| Lens | Filter |
|---|---|
| `today` | posted only, dated on or before today |
| `booked` | everything entered, any date |
| `forecast` | booked, plus projected occurrences, capped at the horizon |

`posted` means `status === 'posted'`. In v2 `status` is required, so there is no
"absent means posted" rule.

> ⚠️ **DIVERGES FROM v1** — v1's absent-means-posted convention is read the
> opposite way by the AI context builders, which filter `status !== 'posted'` and
> therefore silently exclude **every manually entered transaction** from anomaly
> and health analysis.

### 2.2 Running balances

```
envelopeRunning(txs, envelopeId) -> Map<TxId, Cents>   // seeded at 0
accountRunning(accounts, txs, accountId) -> Map<TxId, Cents>  // seeded at openingBalance
```

Both walk date-ascending with a stable tiebreaker (needed for *display* ordering
even though the arithmetic is commutative).

**A zero-delta row still produces an entry.**

> ⚠️ **DIVERGES FROM v1** — v1's account running-balance walk *skips* zero
> deltas, so a self-transfer (both legs the same account, netting to zero) leaves
> no entry at all. That invisibility is exactly what the self-transfer validator
> was written to surface — a defect compensating for a defect.

### 2.3 Unallocated

```
unallocated(accountBalances, envelopeBalances, accounts) =
    Σ(accountBalances where account.type !== 'investment')
  − Σ(envelopeBalances)
```

**A definition, not a derived quantity.** Positive = money not yet assigned.
Negative = overallocated, a warning state.

Investment accounts are excluded because holdings are tracked for net worth and
are not available cash. Credit cards are **not** excluded — their negative
balances correctly reduce unallocated. Pension-flagged accounts are
`type: 'investment'` and therefore excluded too.

**Both sides must be read through the same lens**, or the figure stops
reconciling, which is the one thing it exists to do.

A check on this identity can only ever pass and is therefore not an invariant.
The identity that *does* need asserting is per-account:
`balance == openingBalance + Σ postings` (see `../04-invariants-and-proof.md`).

### 2.4 Savings split

Over non-archived accounts, grouped by type: `savings`, `investment` (split into
pension-flagged and not), total. The pension flag is a **display-only** split —
`type` stays `investment` for every behavioural rule.

---

## 3. Spend is not balance movement

```
envelopeSpend(tx, envelopeId) -> Cents   // positive = money out
```

The spending set is **narrow and closed**:

- expense — signed sum of matching split lines, or the full amount;
- debt payment — the full amount;
- investment **buy** only.

Everything else spends **zero**: allocations, envelope transfers, adjustments,
income, investment sells, dividends. Unallocated spends nothing.

**The two questions are different and disagreeing is the point.** Balance
movement asks *what the balance did*; spend asks *what was spent*. An allocation
is money **arriving**, a transfer is money **relocating**, an adjustment is a
**correction**. Counting them would turn "you spent €400 on Home this month" into
a number that also includes the €400 you put there.

Over the spending set exactly, `spend(tx, e) === −(envelope posting amount)`.
Outside it, the posting is non-zero while spend is zero.

> ⚠️ **DIVERGES FROM v1** — this is the shape of a real bug. The monthly review
> carried its own per-type debit loop that was a *near*-copy of the balance walk
> but deliberately not the same rules — which is precisely what made it look like
> a fourth copy someone would "tidy" into changing the numbers. The dividend sign
> bug came out of that gap: a dividend carrying an envelope was counted as a
> debit by the review while the balance walk credited it. v2 keeps the
> distinction but makes it one named function with a stated contract, and pins it
> with a differential test that asserts each exclusion individually so a later
> change that folds allocations into "spending" fails loudly.

---

## 4. Holdings

Derived from investment postings at **average cost**. Never stored.

```
for each investment transaction, date-ascending with a stable index tiebreaker:
  bucket = (accountFor(direction), symbol)

  BUY:      units += u;  costBasis += cash        // cash includes the fee
  SELL:     removed      = min(u, units)
            costRemoved  = units > 0 ? costBasis * removed / units : 0
            proceeds     = u > 0 ? cash * (removed / u) : 0
            realized    += proceeds − costRemoved
            units       -= removed
            costBasis   -= costRemoved
            if u − removed > 0: oversoldUnits += u − removed
            if units === 0: costBasis = 0     // snap rounding residue on a closed position
  DIVIDEND: distributions += cash                       // units, basis unchanged
  ADJUST:   units += Δu;  costBasis += Δcost            // signed, no cash leg
```

Bucket account by direction: **buy → destination**, **sell / dividend / adjust →
source**.

**Every division states its rounding mode** (R3). Units are scaled integers
(`../01-domain-model.md` §1), so the ε-comparisons v1 needed for float drift
become exact tests against zero. The two divisions round **half-to-even on
the cent**, and `costRemoved` is computed as `costBasis × removed / units` in
a single expression — never via a pre-rounded `avg` — so rounding error cannot
compound across partial sells. Proceeds proration is likewise
`cash × removed / u` in one expression.

**The sort needs an explicit index tiebreaker.**

> ⚠️ **DIVERGES FROM v1** — v1's holdings sort returns 0 on same-date ties and
> relies on sort stability, unlike the balance walks which use an explicit index.
> The holdings case is *more* order-sensitive, not less: a same-day sell
> appearing before its buy **oversells**, zeroing the position and inflating
> `oversoldUnits`.

### 4.1 `oversoldUnits`

A sell can exceed the units on record — most often a position transferred in
from another broker whose original buy was never entered, so part of what is
being sold has **no cost basis here at all**.

Booking the full proceeds against that partial cost reports every unaccounted
unit as pure profit. The rule above books only the proceeds attributable to
units that can be costed, and records the shortfall.

Worked case: hold 50 @ €10 (basis €500); sell 100 for €1000. Accountable
proceeds = 1000 × 50/100 = 500, cost removed 500 → **realized 0**,
`oversoldUnits: 50`. The pre-fix behaviour reported €500 of invented profit.

`oversoldUnits` is a **data problem to surface, not a number to trust or
silently add in.**

### 4.2 Overrides and manual corrections

- **Manual corrections are ordinary postings** with `source: 'manual-correction'`,
  aggregated identically to any other. They are additional history, not
  overrides.
- **A `HoldingOverride` applies only where no posting history exists** for that
  (account, symbol) pair — a watchlist entry. Where history exists, computed
  values win outright, and the override contributes only its display name.

> ⚠️ **DIVERGES FROM v1** — v1 keeps manual corrections in
> `meta.investments.manualRows`: **a second, hidden transaction ledger inside the
> metadata document**, invisible to every query, filter, report, invariant check
> and AI tool. It reaches the holdings walker only by being synthesized into
> fake transactions wired to a sentinel account id. v1 also fails to normalise
> symbol casing between the two maps before pairing them, so a lowercase key
> silently fails to match; returns a shared, unfrozen memoized array that a
> caller can corrupt by sorting in place; and omits `oversoldUnits` from
> override-only rows, giving two row shapes.

---

## 5. Invariants

Every validator returns `{ code, params }[]`. Empty means valid.

In v2 these run at the **write boundary** and reject, and additionally as an
**import/migration tool**. They are not a permanent UI fixture, because the
schema makes most of them unrepresentable.

| Code | Rule |
|---|---|
| `postings.empty` | A transaction with no postings |
| `ref.unknownAccount` / `ref.unknownEnvelope` | A posting target that does not resolve. Archived targets are **valid** — historical transactions legitimately reference them. |
| `tx.invalidDate` | Not `YYYY-MM-DD`, or not a real calendar day |
| `tx.duplicateId` | Two transactions sharing an id |
| `tx.selfTransfer` | Both legs of a transfer on the same target |
| `occurrence.doubleSettled` | Two occurrences claiming one transaction |
| `plan.unpostable` | A recurring item whose gates can never pass (§3.2 of the scheduling doc) |

**`tx.invalidDate` must check the round trip**, not just the shape: `2026-02-31`
parses in JS (rolling into March) but would put the transaction in a month its
own date string denies. Real leap days pass; fake ones do not.

> ⚠️ **DIVERGES FROM v1** — v1's checks are advisory: they light a status-bar
> badge and block nothing. Of seventeen stated invariants, two are enforced at
> the write boundary, nine are checked after the fact, and six have no mechanism.
> v1 additionally needs three validators that v2 does not have at all —
> `splitSumMismatch`, `negativeAmount`, and `staleFromBudgetLink` — because in v2
> unbalanced postings, negative magnitudes and stale string links are all
> unrepresentable.
>
> One v1 counting detail is worth preserving: for duplicate-group problems,
> flag **every row in the group**, not just the extras. With two rows for one
> occurrence, neither is knowably the original.
>
> And one v1 bug worth not repeating: the total problem count must be **summed
> over the category map**, not enumerated by hand. It used to name each category,
> so adding one incremented the map but not the total — and the badge, which
> gates on the total, stayed hidden while the dialog behind it had something to
> say.

---

## 6. Tags

Tags live in the note text; there is no tag field.

```
/(?:^|\s)#([\p{L}\p{N}_-]+)/gu
```

The `#` must be at start-of-string or preceded by whitespace, which keeps URL
fragments out (`example.com/page#frag` yields nothing). Matching stops at the
first character outside the class, so `#tag,` yields `tag`. Names are lowercased
on extraction; the note preserves original casing. Match is exact — `#tripoli`
does not satisfy a query for `trip`.

Build the regex per call or use `matchAll`; v1 shares a module-level `/g` regex
and resets `lastIndex` manually, which is safe only by accident.

---

## 7. Projected interest

Savings accounts may carry `interestTiers` (`../01-domain-model.md` §3.3). The
projected annual interest on a balance is **marginal over the tiers**, like a
tax schedule:

```
annualInterest(balance, tiers) -> Cents
  balance <= 0 -> 0
  prev = 0
  for each tier in order:
      cap   = tier.upTo ?? ∞                      // last tier is unbounded
      slice = min(balance, cap) − prev
      if slice <= 0: break
      interest += slice × tier.rate / 10_000      // BasisPoints; round half-to-even per tier
      prev = cap
```

This is a **display projection only** — no transaction is ever generated from
it. (v1 parity: `computeAnnualInterest` in `js/engine/tx-amounts.js`, shown on
account cards; v1 stores the rate as a percent, v2 as basis points — the
migration converts.)

Tiers are validated at the write boundary: `upTo` strictly increasing, the
last tier `upTo: null`, non-negative integer rates.
