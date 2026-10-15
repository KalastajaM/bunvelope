# Bunvelope v2 — Migration &amp; the Reconciliation Oracle

How a real v1 budget becomes a v2 budget, and how you know the rebuild is right.

---

## 1. The oracle

**The running v1 app is the acceptance oracle for v2.** Import the real budget,
run both, reconcile to the cent.

This is the single most valuable asset the rebuild has, and it is the reason a
greenfield build should **not** discard the v1 codebase. Give it up and there is
no way to know v2 is correct.

### 1.1 But the oracle is wrong in known places

Every `⚠️ DIVERGES FROM v1` marker in this document set names a point where v1's
answer is a defect. **At those points a disagreement means v2 is right.**

The migration harness must therefore produce a **three-way** report, not a
two-way diff:

| Verdict | Meaning | Action |
|---|---|---|
| **Match** | v1 and v2 agree | Nothing |
| **Expected divergence** | They disagree at a manifest entry (§1.3) | Assert the value matches the entry's predicate — exact where computable, direction otherwise |
| **Unexplained divergence** | They disagree anywhere else | **Stop.** A bug in v2, or an undocumented v1 behaviour. |

The third category is the entire point of the exercise. An unexplained
divergence is either a v2 defect or a v1 behaviour nobody wrote down — and both
need resolving before the number is trusted.

### 1.2 Known divergences to expect on real data

These will fire on the owner's real budget:

- **Stress-page runway** — v1 counts dividend plan items as expenses. v2 will
  show a higher runway.
- **AI-proposed envelope transfers** — v1 writes a field the engine does not
  read, so those transactions moved no money. v2 will show envelope balances
  differing by the total of any such transfers ever accepted.
- **Forecast lens after editing a planned item** — v1 may be serving a stale
  cached array.
- **Any envelope whose spare disagreed with its balance** — v1's netting chain
  has three passes with a claim-tracking protocol; v2 has a foreign key.
- **Reports vs dashboard "spent this month"** — v1's dashboard donut and trend
  compute this independently of the KPI beside them and include scheduled rows
  where the KPI does not.

Expect the reconciliation to *find* problems in the v1 data, not just in v2.
These five predictions seed the expected-divergence manifest (§1.3) — they are
inputs to it, not a substitute for it.

### 1.3 The expected-divergence manifest

A prose marker is not something a harness can diff against. The mechanism is a
machine-readable manifest, `expected-divergences.yaml`, built and maintained
alongside the harness and seeded from the five predictions in §1.2.

Entry shape:

```yaml
- id: ai-envelope-transfer
  marker: "00-architecture.md §3.1 — from_envelope vs from_envelope_id"  # doc + section this is documented at
  surfaces: [envelope-balance, spare, monthly-review]  # every surface this reaches, downstream included
  predicate: "v2 = v1 + sum(unread AI-transfer amounts)"  # exact expected value where computable, else a direction
```

**The cascade rule.** An expected divergence is either *data-shaped* or
*algorithm-shaped*, and the two are handled differently:

- **Data-shaped** — bad rows in v1 (a duplicate `from_budget` key, a stale
  link) — is neutralised **at source**: the v1 copy is repaired before
  comparison runs, so every downstream surface simply matches. It needs no
  manifest entry once the source row is fixed.
- **Algorithm-shaped** — v1's engine computes a different answer from clean
  inputs (the AI-transfer defect, the stress-runway divergence) — cannot be
  fixed at source, so the manifest entry must enumerate **every** downstream
  surface the divergence reaches, not only the one it originates at. A diff on
  a surface not named by any entry is an **Unexplained divergence** — Stop —
  even when it is plainly caused by a divergence the manifest already knows
  about elsewhere.

**The float-noise loop.** v1's float accumulation will surface small,
unmarked cent-diffs on the first reconciliation runs. Each one is
investigated — never waved through as "probably rounding" — and, once its
cause is understood, added to the manifest with its **exact** expected value.
Tolerance stays zero throughout; there is no epsilon anywhere in this harness.
A diff that cannot be pinned to an exact predicate stays Unexplained.

---

## 2. Data mapping

### 2.1 Collections

| v1 | v2 | Notes |
|---|---|---|
| `envelopes.json` | `categories` + `envelopes` | Category promoted from free text to an entity |
| `accounts.json` | `accounts` | `type` becomes required |
| `transactions.json` | `transactions` (with postings) | See §2.2 |
| `budget-items.json` | `planItems` | Sign convention flips; schedule cells become explicit |
| `envelope-templates.json` | `templates` | Manual and dynamic unify |
| `budget-meta.json` | `settings` + 4 collections | The junk drawer is unpacked |
| `scheduled.json` | — | **Dead.** Documented in the README, shipped in the example budget, read by no code. Delete. |
| — | `occurrences` | **Derived during migration, settled/skipped only.** See §2.3. |

### 2.2 Transactions → postings

Mechanical, per the table in `02-business-rules/02-postings-and-balances.md` §1.
Three transformations need care:

**Amounts to integer cents.** `round2(x * 100)` then assert the round trip. Any
row whose cent value does not round-trip is reported, not silently coerced.

**`set`-mode fill lines.** These must be resolved to deltas against the balance
*as of that fill's date*, walking the migrated ledger in order. This is the one
genuinely stateful step in the migration and it must run after all other
transactions are converted. **The walk must use v1's exact ordering** — date
ascending with the original-index tiebreaker — or the resolved deltas will not
reproduce v1 balances and the oracle will report false divergences.

**`__none__` → `targetId: null`**, honouring v1's asymmetry: it was *dropped* for
expenses, income and investment transfers, and *kept* as a bucket for fills,
envelope transfers, debt payments and adjustments. Reproduce v1's actual
behaviour here — this is a data migration, not a correction.

### 2.3 Deriving occurrences — the substantive step

v1 has no occurrence records. They must be reconstructed:

```
for each plan item with recurring = true:
    for each occurrence the v1 walker would have generated, from the item's
    activeFrom (or its first materialised transaction) through today:
        scheduleDate, dueDate  <- recompute via the v2 calendar
        if a transaction carries from_budget = `${itemId}:${monthKey}`:
            persist { status: 'settled', settledBy: that transaction's new id }
        else if the key appears in meta.scheduledTombstones:
            persist { status: 'skipped' }
        else:
            skip — nothing to persist
```

**Only settled and skipped occurrences are persisted.** Migration never
writes a `pending` record: pending occurrences are computed on demand from
the plan item's schedule, exactly as they are in steady-state v2
(`01-domain-model.md` §3.7) — there is no migration-time exception to that
rule.

Then the same for template fills (`tpl:${tplId}:${monthKey}`) and rollovers
(`rollover:${envId}:${monthKey}`).

**Three problems the migration will surface, and none should be auto-corrected:**

1. **Duplicate `from_budget` keys** — two transactions claiming one occurrence.
   v1's invariant checker already reports these. The migration cannot know which
   is the original. **Report and stop**; the user resolves them in v1 first.
2. **Stale keys** — a key naming a month the transaction's date contradicts by
   more than the link window. v1 asks the user rather than correcting, *because
   "this is the October bill" and "I am paying the August bill late" produce
   byte-identical rows.* The migration must do the same.
3. **Unlinked payments** — a hand-entered payment that plainly settles an
   occurrence but carries no key. Run v1's assistive matcher, present the
   mutually-unique proposals, and let the user accept them **in v1** before
   migrating. Every one accepted is a `settled` occurrence rather than a
   `pending` one plus a stray transaction.

> Doing all three **in v1 first** is deliberate: it means the migration input is
> already clean and the reconciliation has fewer expected divergences to explain.

### 2.4 Plan items

- `default_amount` is stored **signed, negative for expenses** in v1 — the
  opposite of the transaction convention. Take the magnitude; direction comes
  from `kind`.
- `monthly_schedule` cells are polymorphic. Decode: `true` → `{active: true,
  override: null}`; a number → `{active: true, override: n}`; `false`/absent →
  `{active: false}`. For `null` or a non-numeric string, **v1's own two decoders
  disagree** — pick the `computeAnnual` reading (inactive), report every row
  affected, and check them by hand.
- Drop `stress_cut_pct` (the legacy scalar carried alongside its replacement map)
  and `template_id` (the removed income→template link). **Migrate the live
  stress data**: `stress_category` → `stressCategory` and `stress_cut_pcts` →
  `stressCuts` (percent → basis points). Stress modelling is in scope
  (2026-08-27) and this is user-entered data — where the legacy scalar is the
  *only* cut information an item has, expand it into the map once and report
  the rows so they can be eyeballed.
- Convert `interestTiers` rates from percent to basis points
  (`02-business-rules/02-postings-and-balances.md` §7).

### 2.5 Unpacking `budget-meta.json`

| v1 key | v2 destination |
|---|---|
| `schemaVersion`, `name`, `currency`, `locale` | `settings` |
| `emergency_*` | `settings.emergency` |
| `scheduledTombstones` | `occurrences` with `status: 'skipped'` |
| `investments.prices` | `prices` collection |
| `investments.holdingOverrides` | `holdingOverrides` collection |
| `investments.payeeRules` | `payeeRules` collection |
| `investments.manualRows` | **`transactions`** — ordinary postings with `source: 'manual-correction'` |
| `ai.*` | Per-user runtime state, **not** budget data |
| `csvTemplates` | `importMappings` |

**`manualRows` is the notable one.** It is a second, hidden transaction ledger
living inside the metadata document, invisible to every query, report and
invariant check in v1. Migrating it into the real ledger is what makes those
positions visible for the first time — and is a likely source of *expected*
divergence in investment figures.

**`ai` consent travels with the budget in v1**, so a re-imported budget carries
someone else's consent state. Do not migrate it.

### 2.6 Ids

v1 ids are human-readable slugs; v2 ids are ULIDs. Build a mapping table during
migration and keep it — it is what lets the reconciliation harness pair a v1 row
with its v2 counterpart.

Carry the v1 slug forward as the v2 `slug` field on envelopes and accounts, so
CLI usage (`--envelope groceries`) keeps working.

**Check v1 id uniqueness first.** v1 never enforces it, and imports are the known
source of duplicates. A duplicate makes one row unreachable while the other
answers for both.

---

## 3. The reconciliation harness

A command that runs both engines over the same budget and reports.

```
bunvelope verify --against <v1-budget-folder> --as-of 2026-08-26
```

Compare, per lens (`today`, `booked`, `forecast` at each horizon):

| Surface | Granularity |
|---|---|
| Account balances | Per account, plus total |
| Envelope balances | Per envelope, plus total |
| Unallocated | Single figure |
| Monthly review | Every column, every envelope, several months |
| Envelope projection | `low`, `high`, `closing`, `firstNegative`, per envelope |
| Spare | Per envelope |
| Reports | Every aggregate over several ranges |
| Age of Money | Headline plus 12-month history |
| Holdings | Units, cost basis, realized, distributions, per position |

**Tolerance is zero.** Money is integer cents in v2; a one-cent difference is a
real disagreement, not rounding, and v1's float accumulation is itself one of the
things being checked.

Run it at several `--as-of` dates, not just today — month boundaries, a DST
boundary, and a date where a scheduled bill is due-but-unposted are the
interesting ones.

---

## 4. Sequence

1. **Clean the v1 data in v1.** Resolve duplicate keys, stale links, and unlinked
   payments using the tools already shipped there.
2. **Run the migration into a v2 store.** It reports; it does not correct.
3. **Reconcile.** Expect divergences only at manifest entries (§1.3).
4. **Investigate every unexplained divergence** before trusting any figure.
5. **Run both in parallel** for a period, entering transactions in v2 and
   re-reconciling, until the divergence set is stable and understood.
6. **Retire v1** — but keep the checkout. It is the only oracle that exists.

**The cloud interim.** v1's cloud deployment keeps serving until v2 sync
exists — step 6 retires the local oracle *after* the cloud usage has a v2
path, not before. The at-rest encryption stance changes with the target: v1
cloud offered client-side E2E because a server held the data; local-only v2
relies on OS-level disk encryption (FileVault) until sync arrives, at which
point the opaque op envelope is the E2E unit (`06-change-log.md` §5).
Migrating an encrypted cloud budget means exporting it decrypted from v1
first — the migration reads plaintext collections.

---

## 5. The other consumer

A separate Budget project **live-links** this repo's engine — its scripts import
`js/engine.js` directly and fall back to a vendored snapshot only if it is
missing. An engine change here changes that project's numbers immediately, with
no port step.

The rebuild must therefore either keep the v1 engine importable at its current
path for as long as that project needs it, or coordinate a cutover. Note that its
vendor-refresh procedure regenerates a manifest **from the directory tree** — a
new engine module is otherwise never hashed and its drift check stays silent
about it.

This is out of scope for the rebuild itself, but it is a real constraint on when
v1 can be deleted.
