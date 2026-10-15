# Calendar &amp; Scheduling

Normative. Cross-cutting rules R1–R11 in `README.md` apply throughout.

---

## 1. The banking calendar

**Calendars are data, not code.** A country is a record in a registry, not a
branch in a switch statement.

> ⚠️ **DIVERGES FROM v1** — v1 hard-codes ten countries as a `switch`, with each
> country's rules expressed as imperative date construction. Three consequences:
> adding a country is a code change; the rules cannot be reviewed without reading
> JavaScript; and at least four entries look wrong (§1.5) with no test pinning
> any of them.

### 1.1 The rule algebra

Every banking holiday any supported jurisdiction needs is expressible in six
primitives:

```ts
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6        // 0 = Sunday

type HolidayRule =
  | { kind: 'fixed';            month: Month; day: Day }
  | { kind: 'easterOffset';     offset: number }              // days from Easter Sunday
  | { kind: 'nthWeekday';       month: Month; weekday: Weekday; n: 1|2|3|4|5 }
  | { kind: 'lastWeekday';      month: Month; weekday: Weekday }
  | { kind: 'weekdayOnOrAfter'; month: Month; day: Day; weekday: Weekday }
  | { kind: 'offsetFrom';       ref: HolidayId; offset: number }

type Holiday = {
  id:          HolidayId
  name:        string                             // display only, never logic
  rule:        HolidayRule
  observance?: 'none' | 'nearestWeekday' | 'followingMonday' | 'nextWorkingDay'
                                                                // default 'none'
}

type BankingCalendar = {
  id:       string                                // 'FI', or any user-defined id
  name:     string
  weekend:  Weekday[]                             // default [0, 6]
  holidays: Holiday[]
}
```

Two primitives earn their place specifically:

- **`weekdayOnOrAfter`** expresses the Nordic floating holidays directly —
  Finnish Midsummer Eve is *the first Friday on or after June 19*, All Saints is
  *the first Saturday on or after October 31*. That "October 31, not November 1"
  subtlety caused a real v1 bug (in years where Oct 31 is itself a Saturday, Oct
  31 **is** the holiday). As a declarative rule the subtlety lives in the data
  (`{ month: 10, day: 31, weekday: 6 }`) where it can be read and checked, rather
  than in a hand-written scan loop.
- **`offsetFrom`** expresses Midsummer Day as *Eve + 1* without recomputing the
  floating date, so the pair can never drift apart.

**`observance`** covers weekend shifting. The US is the live example, and the
rule its banks actually follow is **asymmetric**: a federal holiday falling on
a Sunday is observed the following Monday (Reserve Banks close), but one
falling on a Saturday produces **no bank closure at all** — per the Federal
Reserve's own K.8 schedule, Reserve Banks stay open the preceding Friday
(only the Board of Governors closes). So the US banking calendar uses
`followingMonday`, not `nearestWeekday`. `nearestWeekday` (Saturday → the
preceding Friday, Sunday → the following Monday) stays in the algebra for
calendars that genuinely observe it — the OPM federal-employee convention and
the NYSE do — but it is not what US banks do, and encoding it for `US` would
wrongly emit e.g. 2026-07-03 as a holiday. Verified 2026-08-27 against the
Fed's schedule; see `../fixtures/calendar/US.json`. v1 does no observance
shifting of any kind.

`followingMonday` shifts a **Sunday**-observed holiday to the next Monday; it
does not define a Saturday case, so a holiday that can land on Saturday must
not use it. `nextWorkingDay` covers that case and the harder one beside it —
holiday-on-holiday collisions, where a fixed weekend-shift target is itself
already spoken for. It substitutes forward to **the next day that is neither
a weekend day (per `calendar.weekend`) nor another holiday already observed in
the same calendar's holiday set for that year**, resolving holidays with this
observance in the fixed order of their un-shifted rule dates so an earlier
holiday's substitute is already fixed before a later one checks it as an
obstacle. This is what expresses the UK chain — Christmas Day on Saturday
substitutes to Monday; Boxing Day on Sunday would ordinarily also substitute
to Monday, but Monday is taken, so it substitutes to Tuesday.

**`weekend` is parameterised** because it is not universally Saturday–Sunday.
A Friday–Saturday weekend is a data value, not a fork in the code.

### 1.2 Easter

The only rule needing real computation. Anonymous Gregorian computus:

```
a = year % 19          b = floor(year/100)     c = year % 100
d = floor(b/4)         e = b % 4               f = floor((b+8)/25)
g = floor((b-f+1)/3)   h = (19a + b - d - g + 15) % 30
i = floor(c/4)         k = c % 4
l = (32 + 2e + 2i - h - k) % 7
m = floor((a + 11h + 22l) / 451)
month = floor((h + l - 7m + 114) / 31)      // 3 or 4
day   = ((h + l - 7m + 114) % 31) + 1
```

Check: Easter 2026 = **2026-04-05**.

Orthodox Easter needs a different computus. It is not required today, and adding
it is a seventh rule kind rather than a change to anything else — which is the
point of the algebra.

### 1.3 Resolution

```
holidaysFor(calendar, year) -> Set<PlainDate>
  1. resolve every non-'offsetFrom' rule to a date
  2. resolve 'offsetFrom' rules against the results of step 1
     (single level; a rule referencing another 'offsetFrom' is a validation error)
  3. apply each holiday's observance shift, processing 'nextWorkingDay'
     holidays in the fixed order of their un-shifted dates (§1.1) — a
     'nextWorkingDay' substitution can land on a day this step has already
     fixed for an earlier holiday, and must treat it as taken
  4. return the set
```

Memoise per `(calendarId, year)`.

### 1.4 The registry

Built-in calendars ship as **data files**, one per jurisdiction, each with a
golden fixture (§1.6). A user may override a built-in or supply their own; the
active calendar is a setting.

An unrecognised calendar id is a **validation error at the boundary**, never a
silent fallback to a partial set.

> ⚠️ **DIVERGES FROM v1** — an unrecognised country silently yields only the
> universal base set, so a typo produces a calendar that is wrong rather than an
> error that is obvious.

### 1.5 Do not port v1's tables on trust

v1 applies a universal base set — New Year, Good Friday, Easter Sunday, Easter
Monday — to **every** country before adding per-country rules. That produces at
least four entries that look wrong, none of them pinned by any test:

| Jurisdiction | Suspected error |
|---|---|
| **US** | Gets Good Friday and Easter Monday from the base set. Neither is a federal banking holiday. Also missing Columbus Day and Veterans Day, and does **no weekend-observance shifting** at all. |
| **DE** | Gets Maundy Thursday (Easter − 3), which is not a German public holiday. |
| **GB** | Gets Holy Saturday (Easter − 1), which is not a bank holiday, and is **missing** the early May bank holiday (first Monday of May). |
| **All** | Easter Monday is a holiday in some jurisdictions and not others; the base set does not distinguish. |

Only Finland is genuinely exercised by tests and by real use. **Verify each
jurisdiction against an authoritative source and pin it with a fixture before
implementing.** Because calendars are data (§1.4), that verification is a review
of a data file rather than an audit of control flow — and a correction is a data
edit, not a release.

### 1.6 Golden fixtures

One fixture per calendar per year. Finland 2026, verified 2026-08-27 against
Suomen Pankki's bank-holiday list plus the statutory weekend-falling holidays
(full research and per-country fixtures in `../fixtures/calendar/`):

```
2026-01-01, 2026-01-06, 2026-04-03, 2026-04-05, 2026-04-06, 2026-05-01,
2026-05-14, 2026-05-24, 2026-06-19, 2026-06-20, 2026-10-31, 2026-12-06,
2026-12-24, 2026-12-25, 2026-12-26
```

Note `2026-10-31` — All Saints, on the Saturday that *is* October 31, which is
the case the naive "first Saturday in November" rule gets wrong.

Two corrections against this document's first draft, both instances of the
§1.5 lesson landing at home: Holy Saturday (2026-04-04) was listed but is
**not** a Finnish holiday — the same Easter−1 error §1.5 flags in v1's GB
table — and Whit Sunday (2026-05-24, `easterOffset +49`) was missing even
though the fixture includes the other always-weekend statutory holidays
(Easter Sunday, Midsummer Day, All Saints).

### 1.7 `workingDayAdjust(date, mode, calendar)`

```
mode 'exact' (or absent) -> return date unchanged, without parsing
step = mode === 'next-work-day' ? +1 : -1
d = date
for at most 14 iterations:
    if not nonWorking(d): return d
    d += step
raise calendar.no_working_day

nonWorking(d) = weekday(d) in calendar.weekend
             or d in holidaysFor(calendar, year(d))
```

`mode` is a validated enum: `'exact' | 'next-work-day' | 'prev-work-day'`.

> ⚠️ **DIVERGES FROM v1** — v1 treats *any* mode string that is not falsy,
> `'exact'` or `'next_work_day'` as `prev_work_day`, and has no iteration cap:
> termination is guaranteed only because no country's table happens to hold seven
> consecutive non-working days. A user-supplied calendar removes that guarantee,
> which is why v2 caps and raises.

Worked cases (FI): `2026-06-13` (Sat) → next `2026-06-15`, prev `2026-06-12`.
`2026-04-03` (Good Friday) → next `2026-04-07` (Fri→Sat→Sun→Easter Mon→Tue),
prev `2026-04-02`. `2026-06-19` (Midsummer Eve) → next `2026-06-22`.
`2026-01-01` → prev `2025-12-31` (a working Wednesday in FI). A walk crossing a
year boundary resolves the next year's holiday set.

## 2. Occurrence generation

### 2.1 The two dates — both are stored

Every occurrence carries **`scheduleDate`** (the raw calendar date the schedule
names) and **`dueDate`** (that date after the working-day adjustment).

```
scheduleDate = `${year}-${month}-${effectivePaymentDay(item, year, month)}`   // §2.2 step 1
dueDate      = workingDayAdjust(scheduleDate, item.dayType, calendar)
```

**Window membership is decided by `scheduleDate`, at both ends. Action is gated
on `dueDate`.**

> ⚠️ **DIVERGES FROM v1** — v1 derives both and stores neither, and must
> re-derive the rule correctly in four separate places. The bug this rule fixes:
> the upper bound used to compare the *adjusted* date, so a bill on the 31st of a
> month whose 31st fell at a weekend was **too late for January's window**
> (payment date `2026-02-02` &gt; `2026-01-31`) and **too early for February's**
> (schedule date `2026-01-31` &lt; `2026-02-01`) — it belonged to neither and
> vanished from every forecast from that month on.
>
> Storing both dates turns a rule that must be remembered into a field lookup.

The corollary survives as a rule about *action*: a caller that must not act
early gates on `dueDate`. The window says *which* occurrence you are looking at;
`dueDate` says *when the money moves*.

### 2.2 The walk

```
generateOccurrences(planItem, from, to, calendar) -> Occurrence[]

 1. Effective payment day — resolved in one place (here), evaluated per month:
      paymentDay >= 1                       -> min(paymentDay, daysInMonth(month))
      paymentDay === 0                      -> daysInMonth(month)     // month end
      otherwise (negative, NaN, non-finite) -> the item is malformed; return []
    This is the one rule every other reference to `paymentDay` in this
    directory (§5.1) points back to — there is no second path.
 2. scanFrom = max(from, activeFrom ?? from)
    scanTo   = min(to,   activeUntil ?? to)
    scanFrom > scanTo -> []
 3. for each calendar month in [scanFrom, scanTo]:
      cell = planItem.schedule[month]
      if !cell.active                     -> continue
      scheduleDate = effective payment day for this month (step 1), as a date
      dueDate      = workingDayAdjust(scheduleDate, dayType, calendar)
      amount       = cell.override ?? planItem.amount
      id           = deterministic occurrence id for (planItemId, scheduleDate)
                     (`../01-domain-model.md` §3.7)
      skip unless: scheduleDate inside [from, to]
               and scheduleDate inside [activeFrom, activeUntil]
      if a stored occurrence with this id exists:
          if status 'skipped'  -> skip
          if status 'settled'  -> emit that stored record verbatim — its amount
                                  is the settling transaction's amount, written
                                  onto the record by `occurrence.settle`
                                  (`../03-api-surface.md` §2.8); the `amount`
                                  resolved above is ignored
      else emit the pending occurrence resolved above
 4. sort ascending by dueDate
```

**The sort is required, not cosmetic**: a `prev-work-day` adjustment can pull a
later month's occurrence before an earlier one (payment day 1 with
`prev-work-day` dates the February occurrence in January).

**Month-end clamping**: `paymentDay: 31` yields Jan 31, Feb 28 (or 29), Mar 31,
Apr 30. Leap-aware.

**`activeUntil` exists because a monthly schedule recurs annually forever.** A
schedule that genuinely ends — a salary, a fixed-term contract, a cancelled
subscription — says so with `activeUntil`, or it fires again next year.

> ⚠️ **DIVERGES FROM v1** — v1's amount resolution drops any occurrence whose
> amount rounds below one cent. That gate had to be kept out of the shared walker
> because **a template has no amount at all** and every template occurrence would
> otherwise be silently dropped. In v2, occurrence generation and amount
> resolution are separate concerns by construction: an occurrence with a zero
> amount is generated and carries `amount: 0n`. Consumers decide whether a zero
> occurrence is interesting.
>
> That v1 gate caused a real bug: **zeroing a scheduled income silently took its
> allocation template down with it**, because the fill was emitted inside the
> occurrence loop.

### 2.3 Zero-amount occurrences

A generated occurrence with `amount: 0n` is real and is emitted like any other —
stored only once settled or skipped, per `../01-domain-model.md` §3.7. It is excluded
from funding math (nothing to fund) and from materialisation (nothing to post),
but it is **visible in the schedule** so the user can see that the month is
configured and its amount is zero — which is different from the month not being
configured at all.

---

## 3. Materialisation

```
occurrence.materializeDue({ asOf }) -> { ops, unpostable }

for each occurrence where status === 'pending' and dueDate <= asOf:
    if amount === 0n                       -> skip (nothing to post)
    if plan item fails its kind gate       -> add to unpostable, continue
                                               (surface-and-continue, not raise —
                                               the rest of the batch still posts)
    emit transaction ops (postings per kind)
    emit op setting occurrence.status = 'settled', settledBy = txId
```

**Batch behaviour is surface-and-continue.** A failed kind gate never aborts
the batch; it adds the occurrence to `unpostable` (surfaced as
`invariants.check` category `plan.unpostable`, §3.2) and materialisation moves
on to the next occurrence.

**Idempotency is a foreign key, not a string convention.** An occurrence is
`pending` or it is not. Running twice is a no-op because the second run sees
`settled`.

**Materialised ids are deterministic — both of them.** The occurrence record's
id is derived from `(planItemId, scheduleDate)` (`../01-domain-model.md`
§3.7), and the transaction the materialiser emits derives its id from that
occurrence id. Two replicas running materialise-due offline therefore mint
identical records and converge to **one** occurrence and **one** transaction
under the merge rules — invariant A9 in `../04-invariants-and-proof.md`. Only
the materialiser does this; manual transactions keep runtime ULIDs.

> ⚠️ **DIVERGES FROM v1** — v1 dedupes purely on a `from_budget` string
> (`itemId:YYYY-MM` for plan items, `tpl:tplId:YYYY-MM` for template fills,
> `rollover:envId:YYYY-MM` for rollovers — **three formats**, plus a fourth
> removed one still in historical data). Four mechanisms trust its uniqueness:
> the materialiser's dedup, the tombstone array, the due-unposted netting, and
> the repair relink. Two rows sharing a key make an occurrence look settled that
> is only half settled, and the invariant checker flags **every** row in the
> group because with two rows for one occurrence neither is knowably the original.
>
> v1 also treats the tombstone array as "already exists" in the same set, which
> is why deleting a materialised transaction requires a *second* record to stop
> the next boot recreating it.

### 3.1 Backfill bound

`activeFrom` if set; otherwise the **first day of the current month**. Enabling
recurrence mid-year must not retroactively post prior months; the current-month
default means enabling it mid-month posts this month's occurrence immediately.

### 3.2 Kind gates

A plan item cannot materialise when:

- it names no account, or the account does not resolve;
- **expense**: no envelope, or the envelope is archived or unresolvable;
- **investment buy**: no investment account, or it equals the funding account
  (a transfer to itself), or no live envelope — buys debit the investing
  envelope;
- **investment dividend**: an envelope is *optional*, but if set it must resolve
  to a live envelope.

Income requires no envelope; it lands in unallocated.

> ⚠️ **DIVERGES FROM v1** — v1 **skips silently** on every one of these. An item
> whose account was deleted simply never posts, forever, with no surface telling
> anyone. Worse, the forecast counts its occurrences as due-unposted regardless,
> so the item is charged against the projection's opening balance permanently.
> In v2 a plan item that cannot materialise is a **surfaced configuration error**
> (`invariants.check` category `plan.unpostable`), not a silent skip.

### 3.3 Postings emitted

Per `../01-domain-model.md` §3.5. Amounts are positive magnitudes on the
appropriate posting side; direction comes from the plan item's `kind`.

| Kind | Account postings | Envelope postings |
|---|---|---|
| expense | `account −amount` | `envelope −amount` |
| income | `account +amount` | — |
| investment buy | `funding −amount`, `investment +amount` | `envelope −amount` |
| investment dividend | `cash +amount` | `envelope +amount` (if set) |

**A dividend's paying investment account does not move** — the cash came from
outside the budget.

**Investment fees**: the fee is already folded into the cash amount at entry
(`buy: units×price + fee`; `sell: units×price − fee`), so it is not applied
again. The consequence, which must be documented in the product: after a
flat-price round trip the investment account retains a residual equal to the
fees paid through it, and the fee is economically absorbed by the investing
envelope.

---

## 4. Template fills

A template with a schedule fires on its own calendar, independent of any income
event.

> ⚠️ **DIVERGES FROM v1** — v1 originally emitted a fill only as a *leg of a
> scheduled income occurrence*, so **a month whose income was zero emitted no
> allocation at all** — the paycheck took the budget down with it. Templates now
> carry their own calendar. v2 has only the calendar.

### 4.1 Line resolution

1. Resolve template lines (fixed amount, or percent-of-monthly-plan — see
   `03-planning-and-policies.md` §6).
2. Drop any line whose envelope is missing or archived.
3. Normalise amounts to positive magnitudes.
4. **If no line survives, emit nothing.** A fill is money movement; a
   half-resolvable template moves none of it.

Percent lines are **snapshotted at generation time**: the same template run
against a budget whose food plan grew from 100 to 250 emits 100 then 250, with
nobody editing the template.

### 4.2 Funding source

A template may declare a `sourceEnvelopeId` with its own `sourceSince` date, so
one template can fill from unallocated while a salary lasts and draw a named
buffer envelope afterwards.

When a source applies, one extra posting is appended: `sourceEnvelope −total`.
**The fill then nets to exactly zero across envelopes and unallocated does not
move.**

The source is declined — silently, leaving an ordinary unallocated-funded fill —
when any of:

- no `sourceEnvelopeId`;
- `scheduleDate < sourceSince` (compared against the **raw schedule date**, so a
  `prev-work-day` adjustment cannot skip the drawdown's first month);
- the source envelope is missing or archived;
- the source is **also a target** of the same template;
- **any line is `set`-mode** — the offsetting negative line is meaningless
  against an overwrite. (Templates may still *author* `set` lines; resolution
  to a delta happens only at the command boundary — `02-postings-and-balances.md`
  §1.1 — so this guards the pre-resolution shape and is kept deliberately even
  though a materialised scheduled fill is add-only by construction.)
- the resolved total is not positive.

> The declines are silent by design: emitting a fill whose source leg the
> balance walk would skip would **look funded while leaking from unallocated** —
> exactly the failure the feature exists to prevent. But v2 additionally
> surfaces a declined source as a configuration warning, because v1's silence
> is how a Salary-Buffer funding regime was disconnected for weeks without
> anyone noticing: the buffer envelope never depleted and free-to-allocate
> absorbed the draw as a phantom overallocation.

### 4.3 Balances are not consulted

A template that outruns unallocated **posts in full and drives unallocated
negative**, rather than being skipped. The trigger stays predictable from the
schedule alone. Overallocation is a state the product displays, not an error the
engine prevents.

---

## 5. Forecasting

**Forecast occurrences are `Occurrence` records with `status: 'pending'`. They
are never synthesized as transactions.**

> ⚠️ **DIVERGES FROM v1** — this is the structural change. v1 synthesizes fake
> transaction rows carrying in-memory-only markers (`is_forecast`, `is_planned`,
> `forecast_budget_item_id`, `forecast_month_key`, `forecast_dedup_key`, and
> `forecast:` / `planned:` / `forecast:tpl:` id prefixes) and **merges them into
> the same array as real transactions**. Every consumer must then remember to
> filter. Deduping them against reality requires a `forecastKey()` helper that
> exists solely because hand-composing the key is a live trap: for a template
> fill there is **no budget item at all**, so the hand-composed form produced the
> literal string `"undefined:2026-11"`, matched nothing, and the row was counted
> **twice — once real, once forecast**.
>
> In v2 a forecast query returns `{ actual, projected }` as separate streams and
> the dedup question does not arise: an occurrence is `settled` or it is not.

### 5.1 Planned vs recurring

A plan item that is **not** `recurring` still generates occurrences. It simply
never materialises them automatically.

> ⚠️ **DIVERGES FROM v1** — v1 gates its main forecast on `as_schedule`, and
> needed a *second, parallel* forecast function for planned items. That function
> was added late, and its absence had a severe effect: **in the sample budget 14
> of 15 items are planned**, so omitting them omitted nearly the whole budget
> from every projection, and an envelope funded for exactly that spending read
> as permanently over-funded — the trim rule then advised cutting it.

**Payment-day fallback for planned items.** A plan item with `paymentDay: 0`
schedules to **month end**, not month start — the effective-payment-day rule
at §2.2 step 1, not a separate path for planned items.

> Two reasons, both load-bearing. It keeps *this* month's spend in view — on the
> 16th, a day-1 default places the charge in the past and drops it, telling the
> user nothing is coming when something is. And it avoids inventing an
> intra-month trough for which there is no evidence; the daily walk should get
> its precision from items that actually declare a day. In the reporting user's
> real budget, 22 of 23 planned items leave `paymentDay` at 0.

`activeUntil` **is** honoured for planned items — an ended item must stop being
planned, not merely stop auto-posting. `activeFrom` is **not**: a plan item is
charged for the whole window regardless of when auto-posting began.

---

## 6. Display total of a fill

```
fillDisplayTotal(tx):
  sum over envelope postings, excluding:
    - postings resolved from a `set`-mode input line
    - the negative posting on the funding source envelope
```

> ⚠️ **DIVERGES FROM v1** — v1 abs-sums the fill's lines, which displayed a
> source-funded fill at **exactly double** the money that moves into envelopes.
> It also renders a bare fill row's `amount` as `Math.abs(it.amount || 0)`,
> which for a fill (which has no `amount`) gave `0` **and rendered a minus
> sign** — the `-0.00` the dashboard used to show.
>
> Open in v1 and carried into v2 as a design requirement: a `set`-mode line
> contributes nothing to the displayed figure, so a template mixing add and set
> lines **displays less than it moves**. Because v2 resolves `set` to a delta at
> write time (`../03-api-surface.md` §2.6), the stored fill has no set-mode
> lines and this problem does not arise.

---

## 7. `include: false` is a master switch

An item with `include: false` is inert. It contributes nothing to plan totals, to
funding math, or to the emergency essentials — **and it generates no occurrences,
so it never auto-posts.**

> ⚠️ **DIVERGES FROM v1** — v1 honours `include` in the planning aggregations and
> in the planned-item forecast, and **ignores it in both materialisers**: an item
> excluded from the budget still posts real transactions on its schedule. There
> is no stated intent anywhere, and the inconsistency reads as accretion rather
> than design.
>
> Settled for v2: a budgeting app must not move money the user has switched off.
> Turning an item off is one action with one meaning.

Note the consequence for migration: a v1 budget may contain transactions posted
by an excluded item. Those are real history and are migrated as ordinary
transactions; only future posting stops.
