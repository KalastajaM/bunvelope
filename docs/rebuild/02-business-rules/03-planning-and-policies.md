# Planning &amp; Policies

Normative. Cross-cutting rules R1–R11 in `README.md` apply throughout.

---

## 1. The annual plan

```
annualForItem(item) -> Cents
  Σ over the 12 schedule cells:
      cell.active ? (cell.override ?? item.amount) : 0
```

**`buffer` is not included.** See §3.

> ⚠️ **DIVERGES FROM v1** — v1's `computeAnnual` folds `extra_buffer` into the
> annual figure, which is the root of the overfunding bug in §3. It also decodes
> schedule cells differently from the expense calendar for `null` and
> non-numeric values (R11), and `computeAnnualTotals` uses a truthy `include`
> test where every sibling uses `!== false` (R10) — so an item with
> `include: undefined` is excluded from annual totals and included everywhere
> else. All three verified by execution.

```
annualTotals(items) -> { income, expense, diff }
  income  = Σ annualForItem over included, income-like items
  expense = Σ annualForItem over included, non-income-like items
  diff    = income − expense        // > 0 surplus, < 0 deficit
```

### 1.1 The dividend rule

An item is **income-like** iff `kind === 'income'`, **or**
`kind === 'investment' && direction === 'dividend'`.

A dividend recurrence is *shaped* like a DCA buy — same kind, same schedule
machinery — but *behaves* like income: it credits a cash account and drives no
envelope debit. So it partitions into the income bucket and is skipped by every
expense-only path: the expense calendar, buffers, emergency essentials, dynamic
templates, and the stress model.

An investment **buy** is not income-like; it debits the investing envelope.

> This rule has one live victim in v1: the Stress page uses a bare
> `kind === 'income'` test and never imports the shared predicate, so a dividend
> item counts as an expense — overstating burn and understating runway in every
> scenario. Logged in the project backlog.

---

## 2. The expense calendar and monthly plan

```
expenseCalendar(items) -> Map<EnvelopeId, Cents[12]>
  skip: excluded items, income-like items, items with no envelope
  per month: cell.active ? (cell.override ?? item.amount) : 0
  accumulate per envelope

monthlyPlan(items) -> Map<EnvelopeId, CentsPerMonth>
  Σ(calendar row) / 12, per envelope, rounded half-to-even to the cent
```

`monthlyPlan` is **the canonical definition of "monthly planned spend"** and is
what the dashboard, envelope surfaces, templates and AI context all read.

**`buffer` never enters the calendar** — a pure-buffer item produces an all-zero
row.

An envelope with a calendar row totalling zero gets an entry of `0`, not
absence. An envelope with no plan items at all is absent; callers read
`get(id) ?? 0`.

```
rollingSchedule(row, currentMonth) -> Cents[12]
  position 1 = current month, position 12 = current + 11
  pure calendar-month rotation; no year awareness — the plan is annual and repeats
```

---

## 3. The buffer contract

**`buffer` is a one-off balance FLOOR, not recurring spend.** Exactly one
consumer may use it, and every other must ignore it.

| Consumer | Treatment |
|---|---|
| `calcDepositAndRequired` | **`required += buffer`** — added to the required *reserve*, never to the deposit |
| Expense calendar / monthly plan | **excluded** |
| Dynamic template lines | **excluded** |
| Emergency essentials | **excluded** |
| Emergency requirement | added **once**, at the end, and only the emergency envelope's own buffer |
| Annual plan figures | **excluded** (v2 change — see §1) |

> ⚠️ **DIVERGES FROM v1 — this is the shape of an expensive bug.** Dynamic
> template fills used `annualByEnvelope / 12` as their base, and that annual
> figure folds in `extra_buffer`. A €1,200/yr item with a €354.40 buffer produced
> a monthly fill of **€129.53 instead of €100.00** — overfunding by `buffer/12`
> **every month, forever** — *and* double-counting, because the required reserve
> already demanded the same buffer. The buffer was simultaneously annualised into
> the flow and demanded as a stock.
>
> v1 fixed the fill base but deliberately left `computeAnnual` alone so the
> budget-plan view was untouched, which is why v1 now has two annual definitions.
> v2 has one: buffer is a stock, everywhere.

---

## 4. `calcDepositAndRequired` — the core funding math

```
calcDepositAndRequired(roll: Cents[12], buffer: Cents)
    -> { deposit: CentsPerMonth, required: Cents }
```

`roll[1]` is the month under review; `roll[2..12]` the next eleven.

```
1. Cumulative outflow:  C[0] = 0;  C[k] = C[k−1] + roll[k]
2. annual  = C[12]
3. deposit = ceil(annual / 12)              // ROUND UP — see below
4. required = 0
   for k = 2..12:
       shortfall = C[k] − C[1] − (k − 1) × deposit
       required  = max(required, shortfall)
5. required = max(0, required)
6. required = required + |buffer|
```

Every term, stated:

- `C[k] − C[1]` — everything still to be paid from month 2 through month k.
  `C[1]` is the current month's spend, which is not this reserve's job.
- `(k − 1) × deposit` — the deposits that will arrive in months 2..k.
- The difference is how much must **already be sitting there at the start of
  month 2** for month k not to overdraw.
- Taking the max over all k picks the worst horizon — the binding constraint.

**The deposit rounds up.** Rounding down leaves a systematic sub-cent shortfall
that compounds over the year.

**`required` is clamped at zero before the buffer is added**, so the floor is
always honoured even when the schedule needs nothing.

**The reserve is evaluated from month 2 onward** — it deliberately does not
demand cover for the current month, because the current month's shortfall is
what the review's `projected` and `surplus` columns surface instead.

Worked cases:

| Input | Result |
|---|---|
| `roll` = 100 every month, buffer 0 | deposit 100, required 0 |
| Same, buffer 500 | deposit 100, required 500 |
| `roll` = [100, 300, 100…100] (a 200 one-off in month 2) | annual 1400, deposit 116.67; k=2 binds at 400−100−116.67 = **183.33** |
| `roll` all zero, buffer 1200 | deposit 0, required 1200 |

Negative `roll` entries are a **validation error** in v2. In v1 they are
arithmetically accepted and produce a negative deposit.

---

## 5. Booked future extras

Already-booked, hand-entered future debits are added into the rolling schedule
**before** the funding math runs, so the reserve reflects one-off bookings the
recurring plan does not know about.

Skip a transaction when any holds:

| Skip | Why |
|---|---|
| It is a projected occurrence | The plan item is already in `roll` via its schedule |
| It settles an occurrence | Same reason — it *is* that scheduled item |
| It is dated in the past | Already deducted from the balance; not upcoming |
| It falls outside the 12-month window | Not in scope |

Contributing types: expenses, debt payments, and investment **buys** only.
Sells and dividends return money to the envelope.

**Only positive split lines contribute.** A negative correction line does not
increase need, and must not decrease it either — so the guard is `amount > 0`,
not a signed sum. (Contrast `envelopeSpend`, which *does* sum signed splits.
Different question.)

> ⚠️ **DIVERGES FROM v1** — v1 identifies the first two skips by testing
> `is_forecast` and `from_budget` — an in-memory marker and a string convention.
> In v2 both are structural: a projected occurrence is an `Occurrence`, and a
> settling transaction is one with an occurrence pointing at it.

---

## 6. Dynamic template lines

```
resolveTemplateLine(line, monthlyPlan, goals) -> Cents | null
  fixed:            line.amount
  percent-of-plan:  round-half-to-even-to-the-cent(
                      (monthlyPlan[line.envelopeId] ?? 0) × basisPoints / 10_000)
  goal-required:    goalProgress(envelope, balance, today).monthlyRequired,
                    or null when the envelope has no goal or it is reached (§10)
  result <= 0 -> null (drop the line entirely, do not emit a zero)
```

The base is **`monthlyPlan`** — the buffer-free annual schedule ÷ 12 (§3).

A `goal-required` line makes goal funding automatic: the line tracks the
goal's remaining need as the deadline approaches and **stands down by itself**
the month the goal is reached, with nobody editing the template.

Percent lines are recomputed **at generation time**, so an envelope whose plan
grew gets the larger share on the next fill with nobody editing the template.

Manual and percent lines may be mixed on one template (`../01-domain-model.md`
§3.8). Line order is display order.

---

## 7. Emergency fund

```
required = max(0, monthlyEssentials × durationMonths − credit) + emergencyBuffer
```

**Essentials are annualised**, not this-month:

```
monthlyEssentials = Σ over items where:
      include !== false
      AND not income-like
      AND includeInEmergency
      AND the item's 12-month schedule sums to non-zero
  of round-half-to-even-to-the-cent(itemAnnual / 12)
```

Averaging the full 12-month schedule prevents `essentials × duration` from
multiplying a one-off yearly invoice by the duration merely because the current
month happens to contain it.

**Credit** is the sum of other envelopes' **current** balances, each clamped at
zero:

- `creditMode: 'flagged'` (default) — only envelopes carrying at least one
  flagged essential item contribute.
- `creditMode: 'all'` — every non-archived envelope except the emergency
  envelope itself.

Archived envelopes never credit. The emergency envelope never credits itself. A
negative envelope contributes zero but is **still listed**, flagged `clamped`,
so the breakdown can show it muted rather than silently dropping it.

**Current balance, not the end-of-month projection** — deliberately. In an
actual emergency the user can pause this month's planned spending and redirect
those balances, so the full liquid amount counts toward coverage today.

> The regression this encodes: groceries holding €800 today with €800 planned to
> be spent this month credited **€0** before the fix, and credits the full €800
> now.

Only the **emergency envelope's own** buffer is added, once, on top of the net
need.

> ⚠️ **DIVERGES FROM v1** — v1's function takes a `month` parameter used **only
> as a validity gate** (the result does not otherwise depend on it) and a
> `_refDate` parameter that is destructured and never read, while the JSDoc still
> advertises it. v1 also has a `computeMonthlyEmergencyAmount` export with **no
> production callers** — the requirement inlines its own annualised variant
> because the single-month figure was the wrong base. v2 has one annualised
> helper and no dead parameters.

---

## 8. Monthly review

```
review.month({ month, lens }) -> ReviewRow[]
```

| Column | Derivation |
|---|---|
| `balance` | Projected start / current — the as-of balance for the current month, or the rolled-forward opening balance for a future month |
| `actual` | Spend this month from transactions that are **not** projected |
| `scheduled` | Spend this month from projected occurrences and future-dated rows |
| `planned` | `roll[1]` — this month's planned outflow, plus booked future extras landing this month |
| `deposit` | Level monthly deposit (§4) |
| `required` | Minimum reserve at start of next month, incl. buffer (§4) |
| `projected` | `balance − remaining` |
| `startNext` | `projected + deposit` |
| `surplus` | `projected − required`. Positive = surplus, negative = gap |
| `spendFlag` | `normal` / `over` / `under` |
| `missing` | **`true` when the envelope no longer resolves** — plus the raw id |

### 8.1 The `remaining` term

```
remaining = max(scheduled, planned − actual)
```

Assume the **larger** of (a) debits still explicitly scheduled and (b) the
unspent portion of the month's plan will still hit. This is symmetric:

- **Over budget** (`actual > planned`): `planned − actual` is negative, so
  `scheduled` wins.
- **Under budget**: the remaining plan dominates when nothing else is scheduled.

The pre-fix logic ignored one of the two branches.

### 8.2 The spend flag

```
spendFlag(planned, actual) -> 'normal' | 'over' | 'under'
  |planned| < 100                                        -> 'normal'
    // effectively zero: under €1.00, an unplanned envelope cannot be over
  band = max(100, round-half-to-even-to-the-cent(|planned| × 5 / 100))
    // dead band: €1.00, or 5% of |planned| if larger — the magnitude, so a
    // negative planned value cannot shrink its own band
  actual > planned + band  -> 'over'
  actual < planned − band  -> 'under'
  otherwise                -> 'normal'
```

Never flagged when `planned` is effectively zero — an unplanned envelope cannot
be over. The dead band absorbs cent-level noise between `planned` and `actual`
that is not a meaningful signal.

> ⚠️ **DIVERGES FROM v1** — v1 exempts the category **`'Return'`** by hardcoded
> English string comparison. In v2, if a category needs exemption it carries a
> flag; the engine never branches on a user-entered display string.

### 8.3 The seeding precondition — v1's most expensive contract

The balance map handed to the review **must be as-of the reference date**, never
the all-inclusive booked view.

> ⚠️ **DIVERGES FROM v1** — v1 states this in a JSDoc and asserts it nowhere.
> The booked view already includes future-dated transactions in the balance, and
> the review then subtracts them a *second* time through `remaining`. The
> reported failure:
>
> | | correct (as-of) | wrong (booked) |
> |---|---|---|
> | balance | 2300 | 0 |
> | scheduled | 2300 | 2300 |
> | projected | **−250** | **−2550** |
>
> The user saw −€2,550 where the answer was −€250. v2 removes the trap: the
> review is a query that resolves its own balances from the lens it is given, so
> there is no seed to get wrong.

### 8.4 Roll-forward

To review a future month, chain: each month's `startNext` becomes the next
month's opening balance, walking one month at a time from the current month.

The reference date stays **fixed** across every iteration — a transaction dated
next month is still "projected" when the cursor reaches next month.

---

## 9. Rollover policies

Evaluated at month end, dated the **last day of the closing month**, so
end-of-period reports already reflect the adjustment rather than showing it as a
new-month event.

| Policy | Condition | Effect |
|---|---|---|
| `carry` (default) | — | Nothing. The balance carries. |
| `cover-from-unallocated` | closing balance < 0 | Posting raising the envelope to exactly 0 |
| `zero-monthly` | closing balance > 0 | Posting sweeping the remainder to unallocated |

`cover-from-unallocated` does nothing when the envelope ended positive;
`zero-monthly` does nothing when it ended negative.

**Idempotency is the occurrence record**, not a `rollover:envId:YYYY-MM` string
key.

**Only one implementation.**

> ⚠️ **DIVERGES FROM v1** — v1 has **two**: `applyEnvelopeRollovers` for the real
> posting, and a second copy inside the projection walk annotated "mirroring
> applyEnvelopeRollovers". Two copies of a money rule is exactly the pattern the
> balance walkers were consolidated to eliminate.
>
> v1 also processes **exactly one month back** with no catch-up: leave the app
> closed for three months and two months of rollovers are never emitted. v2
> materialises every closed month since the last processed one, **oldest
> first** — month N's sweep changes the balance month N+1's own rollover is
> evaluated against, so processing out of order would judge a later month's
> policy against a balance that has not yet absorbed the earlier sweep.
> "Closing balance" here is the **posted-only lens, as of that month's last
> day** (`02-postings-and-balances.md` §2.1's `today` lens, with `asOf` pinned
> to the month end rather than to actual today).
>
> And v1 writes English payee text into the stored record (R5).

---

## 10. Goal progress

```
goalProgress(envelope, balance, today) -> {
  fraction, monthlyRequired, daysRemaining, status
}
status ∈ 'reached' | 'on-track' | 'behind' | 'early' | 'no-deadline'
```

```
fraction         = goal.amount > 0 ? clamp(balance / goal.amount, 0, 1) : 1
                    // a zero-amount goal is trivially met
reached          = balance >= goal.amount
daysRemaining    = wholeDaysBetween(today, goal.date)          // signed, DST-safe
monthsRemaining  = max(1, daysRemaining / 30.4375)             // 365.25/12, floored at 1
monthlyRequired  = round-up-to-the-cent(max(0, goal.amount − balance) / monthsRemaining)
```

**`monthlyRequired` rounds up.** A recommendation the user acts on must never
undershoot the goal; the final month (`monthsRemaining = 1`) is exact by
construction. This mirrors §4's `calcDepositAndRequired`, which rounds the
level deposit up for the same reason.

Status:

```
reached                    -> 'reached'
daysRemaining < 0          -> 'behind'
no goal.date               -> 'no-deadline'
expected === null          -> 'early'          // abstain
fraction >= expected       -> 'on-track'
otherwise                  -> 'behind'
```

**The `fraction >= expected` comparison is exact** — neither side is ever
materialised as a rounded float before the compare. `expected` is always
`clamp01(elapsedDays / totalDays)` for some day-count pair from §10.1 (the
`startedAt` span, or the 365-day fallback), so the test decomposes without
forming a fraction at all:

```
goal.amount <= 0 -> true                      // fraction is defined as 1: trivially met
expected <= 0   -> true                       // any funded balance clears a 0% bar
expected >= 1   -> balance >= goal.amount      // must be fully funded
otherwise       -> balance × totalDays >= goal.amount × elapsedDays
```

### 10.1 The pace ramp — and why it abstains

```
expectedFraction(goal, today):
  if goal.startedAt is a valid date and span = days(startedAt -> date) > 0:
      return clamp01(days(startedAt -> today) / span)
  if daysRemaining > 365: return null                 // ABSTAIN
  return clamp01(1 − daysRemaining / 365)
```

`startedAt` — stamped when the goal is first set — gives the ramp a real span,
so a three-year goal is judged over three years and a three-month goal over
three months.

> ⚠️ **DIVERGES FROM v1** — without `startedAt` the fallback `1 − days/365` goes
> **negative** past a year, while `fraction` never does. So `fraction >= expected`
> was trivially true and **every goal more than a year out reported `on-track`**,
> however unfunded. A goal 18 months away at 0% showed green — *which is the one
> direction nobody investigates.* The fix is to abstain beyond the horizon and
> report `early` (a muted state, no verdict), rather than assert.

A `startedAt` that is malformed, on the deadline, or after it is **ignored
rather than trusted** — it would divide by zero or run the ramp backwards, and a
nonsensical span is exactly the case where abstaining beats asserting.

The 1-month floor on `monthsRemaining` means a goal 3 days away reports the whole
remaining amount rather than ten times it, and a past-due goal reports the
remainder rather than dividing by a negative.

---

## 11. Frequency classification

```
classifyFrequency(planItems) -> 'monthly' | 'every-2' | 'every-3'
                              | 'every-4' | 'every-6' | 'annual' | 'irregular'
```

Union the active months across all of the envelope's items, then:

```
n = |active|
n === 0                 -> 'irregular'
n === 12                -> 'monthly'
n === 1                 -> 'annual'
not evenly spaced       -> 'irregular'
n === 6 -> 'every-2'; 4 -> 'every-3'; 3 -> 'every-4'; 2 -> 'every-6'
```

`evenlySpaced` requires `12 / n` to be an integer (so 5, 7, 8, 9, 10, 11 always
fail) and every active index to sit on that interval from the earliest.

**Spacing, not just counting.** Six active months at Jan–Mar + Jul–Sep is *not*
"every 2 months" — it is clumped, i.e. irregular.

> ⚠️ **DIVERGES FROM v1** — v1 returns English display strings (`'Every 2
> Months'`, `'Irregular'`) straight from a pure engine function, with no i18n key
> anywhere, and uses those same strings as a sort key. v2 returns codes (R5).
> Mitigating fact: the v1 function currently has no non-test callers.

---

## 12. Stress scenarios

In scope from day one (decided 2026-08-27). Scenario-based runway with
buffer-floor awareness is a differentiator, and the per-item cut data already
exists in real budgets — the migration preserves it (`../05-migration.md`
§2.4).

Five severity scenarios `A`–`E`, mildest to worst. Every plan item carries a
`stressCategory` (`'A'`–`'E'`, or `'Z'` = never cut) and an optional
per-scenario `stressCuts` map in basis points (`../01-domain-model.md` §3.6).

**A scenario hits an item when `scenario >= item.stressCategory`** and the
category is not `'Z'`. A hit item's contribution is reduced by its stated cut
for that scenario; an absent cut is 0 — being hit does nothing until a cut is
stated.

```
scenarioTotals(items, scenario) -> { income, expense, net }
  over included items (R10), base = annualForItem (§1):
      contribution = hit(item, scenario)
          ? base × (10_000 − cut) / 10_000     // round half-to-even
          : base
  partition by the income-like predicate (§1.1) — the dividend rule applies:
  a dividend recurrence is income and is never an expense to cut.

runway(scenario, cashOnHand, reservedCash) -> months | ∞
  spendable = max(0, cashOnHand − reservedCash)
  burn      = round-half-to-even-to-the-cent(max(0, expense − income) / 12)  // CentsPerMonth
  burn === 0 -> ∞
  runway    = spendable / burn   // fractional months; kept unrounded in computation,
                                  // displayed to one decimal place
```

**`reservedCash` is the buffer floor** — the sum of `buffer` across included,
non-income-like items (§3: buffer is a stock). Only cash above the floors
extends runway; a scenario that respects the floors is the point of having
them.

**`cashOnHand`** is the non-investment, non-archived account total under the
`today` lens. Investment holdings are not runway cash.

> ⚠️ **DIVERGES FROM v1** — v1's Stress page tests `kind === 'income'` bare
> instead of importing the shared income-like predicate, so a dividend plan
> item counts as an **expense** — overstating burn and understating runway in
> every scenario (logged in the project backlog). v1 also falls back to the legacy
> flat `stress_cut_pct` scalar beside the per-scenario map; v2 carries only
> the map.

---

## 13. Payee memory

`payeeRules` (`../01-domain-model.md` §4) is the deterministic categorisation
memory: `payeeKey → { envelopeId?, symbol? }`, where `payeeKey` is the payee
lowercased with whitespace collapsed.

- On recording an expense, the rule for the payee is **offered as the
  default** — never silently overriding an explicit user choice.
- Rules are **learned from confirmations**: committing a transaction whose
  envelope differs from the stored rule updates the rule; the newest
  confirmation wins. No rule is ever created from an AI proposal the user has
  not committed.
- `import.plan` applies the same rules to pre-assign envelopes on proposed
  rows **before** any model-based categorisation — deterministic first, model
  as fallback (`../03-api-surface.md` §3.9).

> v1 builds a payee digest of historical booking patterns but feeds it only to
> the AI `categorize` intent, and persists rules only for payee → symbol. The
> deterministic path is the everyday one; in v2 it comes first and the model
> handles only what the memory cannot.
