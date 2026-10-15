# Bunvelope v2 — Invariants &amp; Proof

What the rebuild must be able to demonstrate, and at which level.

The v1 suite is **defect-driven**: 37 of 93 test files cite a specific past bug,
and ~45 test names use regression language. It documents what went wrong rather
than what must be true. That has a real cost — one v1 commit records deleting a
test whose assertion *"was the bug restated as an expectation."*

v2 inverts that: **specification first, regression second.**

---

## 1. The invariants, formally

### 1.1 Structural — unrepresentable, not merely invalid

| # | Invariant | Enforced by |
|---|---|---|
| S1 | Every transaction has an id, a date, a status, and ≥ 1 posting | Schema |
| S2 | Every transaction's postings conform to a typed event shape (expense, transfer, fill, …) | Typed command inputs — see below |
| S3 | Every posting target resolves to a live-or-archived entity | Foreign key |
| S4 | `tx.date` is a real calendar day in `YYYY-MM-DD` | Schema + round-trip check |
| S5 | `tx.id` is unique | Schema |
| S6 | `occurrence.status === 'settled' ⟺ settledBy !== null` | Schema |
| S7 | A transaction settles **at most one** occurrence | Uniqueness constraint |
| S8 | A transfer's two legs differ | Command validation |
| S9 | Money is `bigint`; no float reaches storage | Type system |

**S2 restated honestly.** The identity everyone writes first —
`Σ(account) − Σ(envelope) = Δunallocated` — is a *definition*: `unallocated`
is defined as that difference, so no posting set can violate it and a check on
it can only ever pass. The real constraint is **shape conformance at the input
layer**: command inputs are typed per event and produce their postings from
the table in `02-business-rules/02-postings-and-balances.md` §1, so a transfer
with one leg or an expense whose envelope legs don't sum to the account leg is
unrepresentable — while storage stays generic postings and the engine never
branches on `label`.

**Parse, don't validate.** S1–S9 make the bad state unconstructible, so
`invariants.check` exists only as an import/migration tool. **In steady state it
must always return empty**, and a debug build asserts exactly that after every
commit.

> v1 by comparison: of seventeen stated invariants, **two** are enforced at the
> write boundary, nine are checked after the fact by a shipped console, and six
> have no mechanism at all. Its transaction validator requires exactly one field
> (`type`) — a record consisting only of `{type: 'expense'}` writes cleanly
> through every layer.

### 1.2 Arithmetic

| # | Invariant | Level |
|---|---|---|
| A1 | `accountBalance(id) = openingBalance + Σ postings(id)`, in every lens | **Property** |
| A2 | Shuffling the transaction array changes no balance | **Property** |
| A3 | `postedOnly ⊆ asOf(today) ⊆ booked ⊆ forecast` as row sets, and every derived total is consistent with its row set | **Property** |
| A4 | Each obligation is counted **exactly once** across every combination of {settled, unsettled, early, late, re-dated, deleted, skipped} | **Property** |
| A5 | Materialising twice is a no-op; migrating twice is a no-op | **Property** |
| A6 | `normalize(normalize(x)) === normalize(x)` | **Property** |
| A7 | Every recommendation's declared unit matches its actual effect | **Property** |
| A8 | Folding an op log twice yields an identical snapshot | **Property** |
| A9 | Materialising the same due occurrence on two replicas and merging yields **one** settled occurrence and **one** transaction | **Property** |
| A10 | Mutating or stripping every `enteredAs` annotation changes no balance, projection or report | **Property** |

**A1 is the real conservation law.** Note that the identity everyone reaches for
first — `accounts = envelopes + unallocated` — is a **tautology**: `unallocated`
is *defined* as the difference, so a test on it can only ever pass. v1 asserts it
anyway. Assert A1 instead.

**A2 is the payoff of resolving `set` at write time.** In v1 it is false, and the
sort order that makes it true is a documented caller obligation no single-row
function can enforce.

**A4 is the dominant bug class stated as a property.** Twelve v1 incidents live
here.

**A10 is what "non-authoritative" means, made checkable.** `enteredAs`
(`01-domain-model.md` §3.5) exists for display and round-trip only; this
property is the fence that keeps a future contributor from quietly reading it
in balance code — the same move as A2, turning a comment into an invariant.

**A9 is A4 under sync**, and it holds only because of two deterministic ids:
`OccurrenceId` (`01-domain-model.md` §3.7) **and** the id of the transaction
the materialiser emits, which is derived from the occurrence id
(`02-business-rules/01-calendar-and-scheduling.md` §3). Both replicas mint the
same ids for both records, so their ops converge under LWW instead of leaving
a duplicate posted transaction. Test it with the HLC merge in the loop, not
just the fold.

---

## 2. Test levels

### 2.1 Property tests — the highest-value new layer

Use `fast-check`. Generate arbitrary ledgers: all posting shapes, splits with
signed lines, adjustments, archived references, unallocated postings, boundary
dates, month ends, leap days.

This layer is what v1 lacks entirely, and it is where A1–A10 live. A10 needs
two mechanisms here, not one: an engine-blindness lint (no balance, projection
or report code path may read `enteredAs`) plus the property test itself — the
lint catches an accidental read at write time, the property test proves it
can't matter even if one slipped past the lint.

### 2.2 Golden-file scenario tests

Property tests cannot express *"a quarterly bill, paid early by hand, in a month
crossing a DST boundary, with a template fill and a rollover."* Encode ~15 such
narratives as `{ ledger, config, expected }` and snapshot **every derived surface
at once** — balances, projection, lens rows, monthly review, reports.

> **Why the whole output vector.** v1's worst projection bugs were invisible to
> per-function unit tests *because the projection stayed self-consistent while
> being wrong.* One commit says it exactly: *"a quantity solved for in one unit
> and shown to the user in another, with no assertion between. The projection
> stays self-consistent throughout, which is why the existing per-function tests
> passed straight over every one."* A whole-vector diff is what makes a
> self-consistent-but-wrong change visible.

Seed it with the real reported shapes: the €183.60 property tax, the €2,550
review interior, the −€49,200 trim, the €122.40-left / −€183.60-spare
contradiction.

### 2.3 Differential oracles — keep this, it works

The single best thing in the v1 suite: a refactor ships with the old
implementation as an oracle over 100+ seeded ledgers. One v1 test even records
that its non-vacuity was **verified by injecting a mutation** and confirming it
was caught.

Institutionalise it, with two changes:

- Every money-function refactor ships with an oracle, deleted one release later.
- **Add mutation testing** (StrykerJS) over the engine with a threshold: the
  score measured on the first green run, rounded down to a whole percent,
  becomes the floor, and the ratchet never decreases from there —
  self-calibrating, so there is a real gate from day one instead of an
  arbitrary number picked in advance. Non-vacuity should not be checked by
  hand, once, on one function.

### 2.4 Golden fixtures for the calendar

One holiday-set fixture per supported country per year. See the verification
warning in `02-business-rules/01-calendar-and-scheduling.md` §1.3 — **do not
port v1's tables on trust.**

### 2.5 Timezone matrix — required, not optional

Run the engine suite under `UTC`, `Europe/Helsinki`, `America/Los_Angeles`, and
a half-hour zone (`Australia/Lord_Howe`). **All four required.**

> A v1 DST test failed locally and passed in CI for an unknown period **because
> CI runs UTC** — the one zone in which the entire date bug class is invisible.

### 2.6 Contract tests for storage

**One suite, run against every adapter.** Assert identically: batch atomicity,
concurrent-write detection, migration idempotence, round-trip fidelity,
partial-failure rollback.

> v1's local adapter would fail atomicity and concurrency outright — it has **no
> version or mtime check at all**. That divergence is invisible today precisely
> because each adapter has its own tests, if any.

### 2.7 End-to-end — six specs, all in the merge gate

1. Golden path.
2. Two-tab concurrent write — assert a conflict is **detected**.
3. **Schedule a bill → let it post → pay it by hand → verify no double count**,
   checking the envelope card, the forecast lens and the transaction list in one
   run. This is the dominant bug class as a user journey, and nothing smaller
   than e2e covers three surfaces at once.
4. Import a statement twice — assert dedup and the closing-balance check.
5. Delete a materialised transaction, reload — assert it does not resurrect.
6. Undo across a commit boundary.

Keep e2e to these. Everything else belongs in the property and golden layers,
which run in seconds.

### 2.8 Command tests

Because `execute(snapshot, input) → ops` is pure, a command test is a pure
function test with no I/O and no DOM. **Every command gets one.** This is the
layer v1 cannot have at all: 21 of 24 of its page modules are untestable because
they import a module that performs DOM side effects at evaluation.

---

## 3. Coverage policy

- **Ratcheting threshold**, never decreasing. Not a fixed number: the starting
  value is whatever the metric reads on the first green run under the gate,
  rounded down to a whole percent — the same self-calibrating rule as the
  mutation-testing floor in §2.3, applied to whichever coverage metric is
  gated here.
- **No untestable layer.** If something cannot be tested, that is a design
  finding, not a coverage exception.
- The lint gate and the test gate must both be green. v1's stated merge gate is
  **currently red** for a reason that can never be committed — a scratch
  directory that is gitignored but not eslint-ignored.

---

## 4. What each v1 bug class costs to prevent

| v1 class | Incidents | v2 mechanism | Level |
|---|---|---|---|
| Real/forecast double counting | ~12 | Occurrence identity + A4 | Schema + property |
| Convention drifted at a call site | ~10 | One implementation + lint | Compile + lint |
| Unit confusion in solvers | ~6 | Branded units + A7 | Compile + property |
| Date / timezone | ~5 | One date module + TZ matrix | Lint + CI |
| Link / identity integrity | ~5 | Foreign keys + op log | Schema |
| Save-path integrity | ~4 | One write discipline | Architecture |
| Async lifecycle | ~3 | No rAF-as-promise | Lint |

Six of the seven are prevented at compile or schema level rather than by a test.
**That ratio is the thesis of the rebuild** — and it is the reason to expect the
v2 suite to be smaller than v1's 93 files while proving considerably more.
