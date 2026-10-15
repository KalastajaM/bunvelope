# Forecast, Projection &amp; History

Normative. Cross-cutting rules R1–R11 in `README.md` apply throughout.

> **Read §3 first if you read nothing else.** Roughly half of v1's netting
> machinery exists only because a scheduled occurrence has no identity. In v2
> most of it evaporates — but the *reasoning* behind it encodes five consecutive
> bug fixes and a deliberately-chosen trade-off, and that reasoning must survive
> even though the code does not.

---

## 1. The lens

Three named modes; a call site chooses a name, never a filter combination.

| Lens | Definition |
|---|---|
| `today` | Posted **and** dated on or before today. What the bank says. |
| `booked` | Everything entered, including future-dated rows. **Default.** |
| `forecast` | Booked (capped at the horizon) plus projected occurrences. |

Both filters are needed for `today`, and neither alone is it: status alone keeps
a future-dated manual row; date alone keeps a scheduled row that has not cleared.

### 1.1 The horizon caps booked rows too

`forecast(D)` means exactly one thing — **the balance as of D** — and every row
in it is dated on or before D, *regardless of provenance*. Capping only the
generated side would make provenance decide whether a date filter applies: a row
dated May 2027 counted because the user typed it, dropped because the app
produced it. That is precisely the defect the lens exists to remove.

**Deliberate consequence: at a short horizon, Forecast can read LOWER than
Booked**, because Booked has no date bound at all. The horizon control sits next
to the lens switcher on screen, which is what explains it.

### 1.2 Separate streams

```
forecast query -> { actual: Transaction[], projected: Occurrence[] }
```

> ⚠️ **DIVERGES FROM v1 — the central change.** v1 concatenates generated rows
> into the real transaction array, then deduplicates them against reality with a
> `forecastKey()` helper. That helper exists solely because hand-composing the
> key is a live trap: a template fill has **no budget item at all**, so
> `${forecast_budget_item_id}:${forecast_month_key}` evaluates to the literal
> string `"undefined:2026-11"`, matches nothing, and the row is counted **twice —
> once real, once forecast**. On the Transactions list that shows as a duplicate
> row; inside a balance it shows only as a wrong number.
>
> With separate streams and real occurrence ids, the dedup question does not
> arise.

### 1.3 Horizon resolution

`eom` = last day of the current month. `3m`/`6m`/`12m` = **last day of the month
N ahead**, independent of today's day-of-month. A custom ISO date passes through.

| today | eom | 3m | 12m |
|---|---|---|---|
| 2026-01-15 | 2026-01-31 | 2026-04-30 | 2027-01-31 |
| 2026-11-30 | 2026-11-30 | 2027-02-28 | 2027-11-30 |

Note this is **not** "the anniversary day, clamped" — contrast the projection
window in §2.1, which *is* anniversary-based. Both are correct for their purpose;
they are different rules and must not be unified by mistake.

### 1.4 Account attribution for planned spend

A planned expense with no account debits its envelope and no account — and since
unallocated is derived as `accounts − envelopes`, that **inflates unallocated by
the row's full amount**: money appearing from nowhere in the one figure whose job
is to reconcile the two sides.

v2's plan items may carry an account independently of recurrence
(`../03-api-surface.md` §2.7), so the primary fix is upstream. Where an item still
has none, attribute from history:

1. The row's own account, if it has one.
2. The **modal account** this envelope's posted expenses actually came from.
3. The modal account overall.
4. The first account that could hold spending.
5. Otherwise **drop the row** rather than emit it accountless.

Steps 2 and 3's histograms are built over **posted expenses in the trailing 90
days** — recent enough to reflect current habits, old enough to not be thrown
by a single month's noise.

Ties break on the accounts array order, so the result is **stable across
renders** rather than dependent on transaction order. Where an envelope genuinely
splits across accounts the choice is arbitrary — but only in deciding *which*
account shows the outflow. Envelope figures, the account total and unallocated
are unaffected either way.

Split expenses credit **every** envelope they touch when building the histogram.

---

## 2. Envelope projection

```
projectEnvelope({ envelopeId, months, asOf, fillDelta?, injections? })
  -> { opening, dueUnsettled, events, daily, months, low, high, closing,
       firstNegative, fillSource, monthlyFill }
```

Composed of four units, split along the boundary the recommendation rules bisect
across:

```
resolveWindow  — calendar arithmetic          ┐ invariant while the rules
gatherEvents   — merge, effect, order         ┘ bisect on fillDelta
walkDays       — day simulation + rollover    ← the only part fillDelta touches
summarize      — extrema
```

The first two are invariant across a bisection, so a caller may hoist them out of
the loop. Returned events therefore carry their **pre-`fillDelta`** effects: the
delta is a property of the *walk*, not of the event set.

### 2.1 `resolveWindow` — a half-open interval

```
start = asOf (local midnight)
targetMonth = month(start) + months
day   = min(dayOf(start), lastDayOf(targetMonth))     // CLAMP first
end   = date(year(start), targetMonth, day − 1)       // anniversary MINUS ONE
```

Two rules, each with a failure it prevents:

- **Anniversary minus one.** Ending *on* the anniversary opens a 13th one-day
  month bucket for a start on the 1st.
- **Clamp before subtracting.** Without it, a 1-month window from the 31st runs
  into a *third* month bucket (Jan 31 + 1 month overflows to Mar 3).
- **`day − 1` can be `0`.** When it is, `end` is, **by rule**, the last day of
  the month before `targetMonth` — this is not an artifact of inherited `Date`
  rollover, which R1 forbids relying on. A start on the 1st (`day = 1`) hits
  this case on every call: `end` lands on the last day of the month before
  `targetMonth`, one day short of the anniversary.

`2026-01-01` + 12 → `2026-12-31` (12 whole buckets). `2026-01-15` + 12 →
`2027-01-14` (**13** buckets, first and last partial).

`months <= 0` must clamp to 1. A one-day window is shaped exactly like a healthy
envelope and is indistinguishable to every numeric rule downstream.

### 2.2 Opening balance

```
opening = balanceAsOf(start) − dueUnsettled
```

`dueUnsettled` is the sum of this envelope's **auto-post expense** occurrences
that are due (`dueDate <= today`) and still `pending` — exactly what running
materialise-due right now would post.

**Why it is folded into `opening` rather than injected as a dated event.**
Forecast generation starts *tomorrow*, so a bill due today or earlier that has
not posted — real money already owed, just not recorded — is in neither the real
set nor the forecast set. Without this correction, `opening` reads fully funded
for exactly as long as it takes someone to run materialise-due, and every rule
downstream calls the envelope healthy on the strength of a bill that is about to
land. A *dated past* event would not work either: the walk never revisits a day
before the window starts, so it would silently never apply.

**Income and investment occurrences are excluded.** An unposted *fill* is money
not yet arrived, not money already spent; folding it in the same way would
**understate** the balance rather than correct it. A deliberate asymmetry.

> ⚠️ **DIVERGES FROM v1** — v1 must reconstruct this set on every call by
> re-walking schedules, applying the materialiser's exact lookback bound, and
> treating the tombstone array as "posted". In v2 it is a query over occurrence
> records with `status = 'pending'`.
>
> v1 also has a live gap here: an item whose account is missing is **skipped by
> the materialiser but still counted as due-unposted**, so it can never post yet
> is charged against `opening` forever. v2 surfaces that item as a configuration
> error instead (`01-calendar-and-scheduling.md` §3.2).

### 2.3 The daily walk

```
bal = opening
daily = [{ date: startStr, balance: opening }]
for each day from start+1 through end:
    for each event on that day, in order:
        apply effect; accumulate into the month bucket's in/out
    if day is month-end: apply the rollover policy
    daily.push({ date, balance: bal })
```

**The daily walk is the point.** An envelope whose bill leaves on the 3rd and
whose fill lands on the 25th is deeply negative mid-month and square by the 31st.
Only a daily walk sees it.

**Events dated on `startStr` are never applied** — the cursor starts at start+1,
and the start day's balance is `opening`, already settled. Every generator honours
this; a caller injecting a hypothetical event must clamp its date into the window
(§4.2).

#### Same-day event order

```
real → projected expense → projected fill → estimated fill → injection
```

**Load-bearing, not incidental.** Where a `set`-mode fill is present, whether it
lands before or after a same-day expense decides whether that expense survives at
all. **Injections last** is what the recommendation bisection depends on: a
hypothetical top-up must apply on top of everything else that day.

> In v2, `set` mode is resolved at write time
> (`02-postings-and-balances.md` §1.1), so stored fills never overwrite and this
> ordering rule matters only for the *estimated* fills the projection synthesises.
> Keep the order anyway — it costs nothing and the injection rule still needs it.

#### Month buckets and `partial`

Each bucket carries `{ opening, in, out, low, high, closing, partial }`.
`partial` marks a bucket that does not cover its whole calendar month.

**A window starting mid-month has two of them — first and last — and that is the
normal case, not the exception.** Only a start on the 1st gives 12 whole buckets.

> **Consumers must never average across partial buckets as if they were full
> months.** v1's overfunded-trim rule did, which dragged the average down and
> understated the cushion it was supposed to preserve.

### 2.4 Rollover in the walk

Applied at month end, mirroring the posted rollover policy — **but this must be
the same implementation, called twice, not two implementations.**

> ⚠️ **DIVERGES FROM v1** — v1 has a second copy inside the projection walk,
> annotated "mirroring `applyEnvelopeRollovers`". Two copies of a money rule is
> exactly the pattern the balance walkers were consolidated to eliminate.

### 2.5 `fillDelta`

A per-**calendar-month** change to this envelope's projected fills, used by the
recommendation bisection.

- **Only a projected fill can move.** A posted fill is money that has landed; the
  rules cannot retroactively change it, and counting it would skew the split.
- **Split evenly across the month's fills, never added to each.** `fillDelta` is
  stated to the user as a monthly figure. An envelope funded by twice-monthly pay
  has two projected fills a month; adding the delta to each would move 2× while
  the label claimed 1×. The projection would stay self-consistent and the
  bisection would still converge — **on a number that means something else than
  it says.**
- **Clamped as a whole.** The trim rule bisects a negative delta; without a
  floor an oversized trim removes more than the month's fills contain and the
  search converges on a phantom. The floor is on the **total**:
  `delta := max(delta, −Σ(month's projected fills))` — the month can lose at
  most what its fills add.
- **A non-finite delta is zero.** In v1 a malformed step could produce
  `round2(Infinity) === 0`, silently zeroing every fill and projecting a year of
  no income.

> ⚠️ **DIVERGES FROM v1 — open defect carried forward.** v1 splits the delta
> **evenly** while clamping **each fill individually**, so with unequal fills
> (1000 + 200) a stated trim of 1200 removes only 800 and the label overstates
> the change. **v2 clamps the delta as a whole** —
> `delta := max(delta, −Σ(month's projected fills))`, applied once to the total
> *before* the even split — rather than clamping per fill or splitting
> proportionally to each fill's size. Rationale: order-independent (no fill is
> "first"), fewer moving parts, and the applied monthly change always equals
> the delta the label states, down to the clamp floor. Accepted consequence:
> after the even split an individual projected fill can go negative intramonth
> (1000 + 200 with delta −1200 → −600 each); the monthly total — the unit every
> consumer of `fillDelta` reasons in — stays exact, and per-fill attribution is
> not user-facing. Rejected: a proportional-to-size split, which repairs the
> per-fill sign at the cost of a second division with its own rounding mode;
> reopen only if per-fill attribution becomes user-facing.

---

## 3. `fillSource` and `monthlyFill`

`monthlyFill` is a **per-calendar-month total** for this envelope — the sum of
every line landing on it in a month, not a per-fill figure. **The same unit as
`fillDelta`.** The two must agree, or an envelope funded twice a month is told
"raise the fill by X" while the arithmetic behind that advice moves 2X.

| `fillSource` | Meaning | What advice is legal |
|---|---|---|
| `scheduled` | A template funds this envelope, **every whole month in the window is funded**, and **every contributing line is add-mode**. Only under all three is `monthlyFill` a true rate. | Everything, including per-month advice. |
| `scheduled-irregular` | Scheduled fills exist, but the window has **gaps** (quarterly, annual, seasonal) or a line is `set`-mode. `monthlyFill` is a **display figure, not a rate**. | One-time top-up only. |
| `history` | No schedule, but hand fills exist. **Median** of the trailing six months, on the **median day-of-month**. | Everything, plus a provenance warning. |
| `none` | No signal. Project no incoming money. | A warning only. |

A `set`-mode line disqualifies `scheduled` even though a *stored* scheduled
fill is add-only by construction (`02-postings-and-balances.md` §1.1) — the
condition guards the pre-resolution template shape, from before the command
boundary erases `set`, and is kept deliberately for that reason.

Rules, each with a failure behind it:

- **Median, not mean** — a mean lets one onboarding `set` or a catch-up top-up
  dominate. With an even count (the trailing six months), the median is the
  **mean of the two middle values**, rounded half-to-even to the cent. The
  median day-of-month takes the **lower** of the two middle values — a day
  cannot be interpolated, and it must be a real one.
- **Read the rate off the first WHOLE month, at *either* end.** The window opens
  mid-month, so the start bucket holds only the fills still ahead of today.
  Excluding just the start month still let the **trailing** partial be selected —
  an annual bonus landing there reported itself as the monthly fill.
  `monthlyFill` is what recommendations are *phrased against*, so a figure read
  off a fraction of a month is a wrong number **shown to the user**.
- **With no whole month funded, report zero** — honest alongside an irregular
  source, where the bonus amount is not.
- **Keep negative monthly sums.** A source-funded template *drains* its funding
  envelope every month. v1 dropped non-positive sums, classed the envelope as
  unscheduled, and the history fallback then abs-summed its own posted drain
  lines into a synthetic **+fill that exactly cancelled the drawdown** — a
  buffer envelope that never depleted in the health view. *A negative monthly
  fill is real information: this envelope is scheduled to lose N per month.*
- **Signed sums in the history path too, never absolute values** — same failure,
  same cause.
- **Only a positive median is a pattern worth extrapolating.** Negative or zero
  means net outflow; synthesising refills from it would invert reality.
- **Include the current month** when today is early in it — that fill has not
  landed yet. Skip dates on or before today; that money is already in `opening`.
- **The test is whether *this* envelope is scheduled to be filled**, not whether
  any fill is scheduled.

---

## 4. Netting — what survives, and why the reasoning matters

### 4.1 Most of it disappears

v1's netting exists because `from_budget` is the only evidence a scheduled
occurrence was paid, and it is **absent exactly when the user recorded the
payment by hand** — a bill typed in ahead of its due date, paid a few days early,
or the survivor after someone cleans up a double-booking and deletes the *tagged*
copy. Key-only dedup then counts the transaction **and** the occurrence.

The reported shape: an envelope holding **122.40** against a **183.60** October
bill funded by a **30.60/month** fill — one that lands exactly square —
reporting **spare of −183.60** and **October out of −367.20**.

Five consecutive fixes (#117, #120, #126, #127, #128) built three separate
netting passes with a shared claim-tracking protocol to work around this.

**In v2 an occurrence is `settled` with a `settledBy` foreign key, or it is not.
All three passes collapse into a status check.**

### 4.2 What survives: the assistive matcher

Linking a hand-entered payment to an occurrence the user never linked is still
worth *offering*. That matcher survives, as a **suggestion surface only**:

```
settles(payment, occurrence) =
     |payment.amount − occurrence.amount| <= 1 cent
  && |days(payment.date, occurrence.dueDate)| <= LINK_DAY_WINDOW (10)
```

Only **outflows** are candidates — a fill or refund is not a payment. Only rows
not already settling something else.

**Proposals require mutual uniqueness**: exactly one candidate payment for the
occurrence, *and* that payment a candidate for no other occurrence.

> Three different strengths of uniqueness, deliberately. *"Was this bill paid?"*
> is answered by **any** plausible payment — two identical rows mean it was
> certainly paid. But *"which row should carry the link?"* is a **data edit that
> suppresses a future post**, so the ambiguity must be gone first. That is what
> makes the double-booking case safe: two identical payments for one bill is
> exactly the situation where a machine cannot know which is "the" payment, so
> both are left alone and the user decides.

### 4.3 The trade-off, which is product philosophy and must survive

v1's #117 fix pooled **any** untagged outflow in the envelope, so ordinary
spending could cancel a bill nobody paid: three unrelated purchases of 60, 70 and
60 erased an unpaid property tax of 183.60 outright, with no signal.

That is a **false negative: it hides a real hole.** Refusing to recognise a
partial or amended payment merely restores a double charge, which **overstates** a
shortfall rather than concealing one.

> **The rule, stated twice over:**
>
> Between a false negative that hides a hole and a false positive that shows one
> too large, **take the second.**
>
> And conversely on the forward side: a coincidentally identical outflow beside a
> due date **will** cancel the bill — but refusing to match leaves a double
> charge, which invents a shortfall the envelope does not have and sends the user
> to fund money that was never missing. Matching too eagerly hides one payment
> behind another the user can *see* sitting in the same envelope, days apart, for
> the same amount. **The second is recoverable by looking; the first is not.**

This principle should govern any future matching heuristic in v2, and it is the
reason `settles()` requires an exact amount rather than a tolerance band.

### 4.4 Month-to-date netting for planned items

One rule genuinely survives on its merits, independent of occurrence identity:
**money already spent this month comes off this month's plan.**

A planned item is recorded by hand and names no budget item, so there is no
specific amount to match. The month's actual spend for the envelope is applied to
that month's planned rows in date order until it runs out.

Three constraints:

- **Only the start month.** Later months have no actuals yet.
- **Rows already settling an occurrence are excluded from the pool**, or the plan
  is netted down twice over.
- **Scoped to one envelope's rows.**

> ⚠️ **DIVERGES FROM v1 — and this one bit hard.** v1's pool is consumed by
> whichever row sorts first, *regardless of which envelope it belongs to*. In the
> real ledger, Groceries and Food &amp; Drinks both post month-end with no fixed
> payment day, sort ahead of nearly every other envelope, and **silently absorbed
> every other envelope's netting pool** — Clothes, Public Transport, Car Charging
> and Car Parking all lost their netting entirely and were charged as if nothing
> had been spent.
>
> v1 also **mutates `row.amount` in place** on a partial net, making the function
> non-idempotent, unsafe on shared rows, and invisible to a caller comparing
> array lengths. v2 returns new rows (R6).

---

## 5. Recommendations

Every amount is **verified**: the rule proposes a candidate, **re-projects with
it applied**, and bisects until the projected low clears the target. Nothing
relies on the curve shifting uniformly, because with a `set`-mode fill or a
`zero-monthly` sweep **it does not**.

Returns `{ kind, severity, amount, unit, date, meta }[]`. **The engine never
formats text.**

### 5.1 The solvers

The "whole unit" both solvers round to is a whole **cent**.

`solveMinimum` rounds **up** to the cent and re-verifies (rounding down could
land under the target), then steps back one cent **on a verified test** — the
bisection lands just above the true answer as often as just below. Its
initial bounds are `lo = 0` and
`hi = Σ|planned outflow| + max(0, floor − openingBalance)` over the horizon —
everything the envelope is scheduled to pay out, plus the hole it starts in
when its opening balance is already below the target floor (§8 point 2 is
exactly that case). The sum of those two is guaranteed sufficient: filling the
opening shortfall and covering every outflow clears any reachable target, so
bisection never needs to search past it.

`solveMaximum` rounds **down** to the cent so a trim never overshoots, then
recovers the last cent the same verified way.

**`envelopeFloor(envelopeId)`** — named in §8, and the "reserve floor" referred
to informally in §5.2 — is not defined in `../01-domain-model.md`. In v2.0 it
is a constant: **0**, for every envelope. A per-envelope floor field — a
user-set "never go below" line, distinct from a goal — is future work; until
it exists, "below the floor" means "negative."

> **`solveMaximum` must not shortcut on `test(hi)`.** The predicate is **not
> strictly monotone**: an oversized delta clamps the month's fill total at zero
> (§2.5), after which the projection stops changing and the predicate
> **saturates**. A shortcut would return the whole search bound exactly when the
> bound is large enough to zero the fill totals — the case where the answer is
> least trustworthy.

### 5.2 `lowAfterStart` — what the rules reason over

Rules minimise over `daily[1..]`, **not** the full series including day zero.

> `daily[0]` carries the opening balance, and *nothing a recommendation can
> propose moves it* — the walk applies events only after the start. So when the
> opening is below the floor (the normal state of any envelope whose reserve is
> not yet funded), a predicate over the full series is unsatisfiable for **every**
> candidate, and the solver correctly reports that no amount works. Correct, and
> useless: **the user is told their shortfall cannot be fixed.**
>
> "You are below your reserve floor today" is a **fact to report**, not a thing to
> solve away.

The displayed low still uses the full series — only the *rules* use
`lowAfterStart`.

### 5.3 Units — where v1 produced −€49,200

Every recommendation carries a **declared unit** (`Cents` or `CentsPerMonth`), and
a property test asserts that applying it produces the stated effect.

> ⚠️ **DIVERGES FROM v1.** The trim rule bisected with a bound of
> `low − floor` — a **balance** — while solving for a per-month **fill delta**. A
> €50,000 cushion against an €800 fill searched up to **49,200** and, because the
> predicate saturates, returned it: a "trim" that rendered as a new monthly fill
> of **−€48,400**.
>
> The correct bound is `min(low − floor, monthlyFill)`: **trimming the entire
> fill is the most that can ever be meant by "fill this envelope less."** In v2
> the branded types make the wrong bound a compile error.

### 5.4 The stand-downs

On `scheduled-irregular`, per-month advice **stands down**. A one-time top-up is
meaningful at any cadence, but *"raise the monthly fill by X"* is not — there is
no monthly fill to raise. Quarterly funding of 2400 is really 800/month, and a
`set` line of 500 moves an envelope already holding 500 by nothing at all.

**A warning must be emitted explaining the absence**, or the sheet simply shows
less advice with no reason given.

A **goal is a reason to park money**, so goal envelopes are exempt from the trim
rule.

> ⚠️ **DIVERGES FROM v1 — open defect.** v1's `goal-shortfall` still phrases
> "raise the monthly fill by X" on an irregular source, and is the one rule that
> bisects the delta **unbounded** — which is what makes the uneven-fill clamping
> defect reachable. v2 applies the stand-down consistently and bounds every
> bisection.

### 5.5 Guard rails v1 lacks

- **An unresolved envelope returns a warning and nothing else**, before any
  numeric rule. A flat-zero projection reads as *perfectly healthy* to all of
  them.
- **The projection must be verified as built from the same input.** v1 accepts a
  caller-supplied projection and never checks, so a mismatched one yields
  silently incoherent advice.
- **Warnings count any budgeted expense, recurring or not.** v1's
  "no scheduled expenses" warning asked only for auto-posting items, and told a
  user with a perfectly good quarterly plan that nothing used the envelope
  **while the projection charged that plan** — the warning contradicted the chart
  beside it.

---

## 6. Age of Money

FIFO pairing of posted income against posted spending.

```
1. Walk posted income in date order -> push { date, remaining } onto a queue.
2. Walk posted expenses in date order -> dequeue from the OLDEST end,
   recording (expenseDate − depositDate) for each unit pulled,
   but only for expenses inside the half-open interval
   `(refDate − windowDays, refDate]` — exactly `windowDays` calendar days
   ending at `refDate` (the day `refDate` itself is included; the day
   `refDate − windowDays` is not).
3. Return the amount-weighted average age, in whole days, rounded
   half-to-even.
```

**Returns null** when there is no qualifying spend in the window, **or when
spending exceeded received income** (the queue ran dry mid-expense). The metric
is only meaningful once income has actually preceded spending. A single starved
expense nulls the whole sample.

**Account transfers and adjustments are ignored** — they shuffle money inside the
system rather than adding or removing it.

Health bands: `>= 30d` green, `14–29d` yellow, `< 14d` red. Tuned for a 30-day
window.

**Drop attribution.** When Age of Money falls by 7+ days, attribute it:
`big_expense` (one expense carries ≥ 40% of the age weight), `income_gap` (a
14+ day gap, counting the gap from window start and the gap to the reference
date, so a window with no income at all is correctly a full-window gap), or
`broad_shift`.

**Money cushion** = liquid balance ÷ recent daily spend. Liquid excludes credit
cards and archived accounts.

> ⚠️ **DIVERGES FROM v1** — v1's Age-of-Money window is `windowDays + 1` days
> (it normalises the reference to midnight first) while the money-cushion spend
> window in the *same call* is `windowDays` days. Two figures returned together
> measure different spans. v2 uses one window definition — the half-open
> interval in step 2 above — replacing both v1 variants.
>
> v1 also replays the entire FIFO queue **once per month** for a 12-month history
> (13 walks per dashboard render). One forward walk emitting all snapshots is
> the correct shape.

### 6.1 The DST rule

Every day span goes through a calendar-day difference:

```
wholeDaysBetween(from, to) =
  round( (Date.UTC(y(to), m(to), d(to)) − Date.UTC(y(from), m(from), d(from))) / 86400000 )
```

Every date the engine measures a span between is a **local midnight**.
Subtracting two of those and dividing by 86,400,000 gives a whole number **only
when no clock change falls between them**:

- **Spring-forward** — the span is N days minus an hour, so `floor` reports N−1.
- **Fall-back** — N days plus an hour, so `ceil` reports N+1.

**Both round the wrong way at the one moment the arithmetic stops being exact.**

> This bit deterministically and hid for a long time: the test failed on any
> DST-observing machine since it was written and stayed green in CI **because CI
> runs UTC**. Hence the timezone matrix in `../00-architecture.md` §6.

Signed and symmetric. Time-of-day is ignored entirely.

---

## 7. Reports

Eight aggregates over an inclusive `[from, to]` range: spending by envelope,
by payee, by month; income vs spending; saving by month; envelope balances;
budget allocation; net worth by month.

**Net worth by month** is new in v2: for each month-end in the range, the sum
of all non-archived account balances as of that date — investment accounts
valued at the latest price point **on or before** that date (`prices` is
append-only history, `../01-domain-model.md` §3.9), everything else at ledger
balance. A month holding a position with no price point yet falls back to the
last known price and the row is flagged `stalePrice`; it is never silently
valued at zero. Holdings with no price at all are valued at cost basis and
flagged `noPricing`.

**"Saving"** counts investment **buys** and transfers into a savings account from
a non-savings account. Savings-to-savings is not net-new; savings-to-checking is
a withdrawal.

Envelope balances are **point-in-time and not date-filtered**.

Any categorical aggregate that groups by envelope or payee caps at the **top 7
keys by value**; the remainder collapses into a single `Other` row.

All eight return **codes and numbers only**.

> ⚠️ **DIVERGES FROM v1** — every one of v1's report defects is a variant of the
> same mistake:
> - English display literals in engine output: `'Other (N)'`, `'(no payee)'`,
>   `'(Unknown)'`, `` `${category} · ${name}` ``.
> - **Hardcoded chart hex colours** in the income-vs-spending series. Series
>   identity belongs to the caller; this is also what blocks dark-mode theming.
> - The `Other` bucket rows carry **no key**, unlike every other row.
> - Envelope balances **truncate instead of bucketing** — the tail beyond the cap
>   is silently dropped, so a chart of "envelope balances" whose total does not
>   match the ledger, with nothing saying so.
> - The unallocated sentinel renders as `'(Unknown)'`, conflating *deliberately
>   unenveloped* with *unresolvable id* and hiding a real data problem behind a
>   benign-looking one.
> - **No lens discipline** — reports aggregate whatever array they are handed,
>   including forecast rows, while the dashboard KPI is posted-only. The same
>   month legitimately reads differently on two screens.
>
> In v2 every report is a query taking an explicit lens (`../03-api-surface.md`
> §3.6).

---

## 8. Spare

```
spare(envelopeId) = projection.low.balance − envelopeFloor(envelopeId)
```

*How much of an unplanned expense this envelope could absorb right now without
ever projecting below its floor through the window, given everything already
scheduled.*

**It can disagree with the balance, for four independent and deliberate reasons:**

1. It uses the **12-month projected low**, not today's balance.
2. It **includes day zero**, so an envelope currently below its floor reports a
   **negative** spare — the size of the hole, which is worth showing rather than
   hiding. (Contrast the recommendation rules, §5.2.)
3. `opening` already has due-unsettled occurrences subtracted (§2.2).
4. It subtracts the floor — reserved money is not spare.

**Feed it the booked lens, never a forecast-resolved array.** Under Forecast the
lens already injects generated rows while the projection generates its own for
the same months — feeding it the lens array double-counts the overlap. Under
Today the lens strips future-dated real rows the projection needs. The same
pinning applies to Age of Money and reconciliation.

> This is the figure that produced the €122.40-left / −€183.60-spare
> contradiction. In v2 the query takes an explicit lens and rejects the wrong
> one, rather than depending on every call site remembering.
