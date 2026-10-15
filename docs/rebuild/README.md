# Bunvelope v2 — Build Specification

A complete specification for rebuilding Bunvelope from scratch: what it must do,
how it must be structured, and how you will know it is right.

**This is normative.** It states how the app is *supposed* to behave, not how the
current implementation behaves. Where the two diverge because the current
behaviour is a defect, the divergence is marked:

> ⚠️ **DIVERGES FROM v1** — *what v1 does, why it is wrong, what v2 must do.*

There are 83 such markers (grep for the bold ⚠️ marker form shown in the
template above; subtract that template itself and its quoted copy in
`00-architecture.md` — `tests/rebuild-docs.test.js` keeps this count and
every cross-reference in this directory honest). They are operationally
load-bearing: the
running v1 app is the **acceptance oracle** for the rebuild (import the real
budget, run both, reconcile to the cent) — and at every marked point **the oracle
is wrong and must not be matched.** See `05-migration.md`.

---

## Documents

| Doc | Contents |
|---|---|
| [`00-architecture.md`](00-architecture.md) | The spine, purity rules, API-first design, the lens, money, dates, enforced layering, persistence |
| [`01-domain-model.md`](01-domain-model.md) | Every entity, field by field, with constraints and delete rules |
| [`02-business-rules/`](02-business-rules/) | The algorithms, stated for reimplementation |
| [`03-api-surface.md`](03-api-surface.md) | The command and query registry; CLI, MCP and UI adapters |
| [`04-invariants-and-proof.md`](04-invariants-and-proof.md) | Formal invariants and the test strategy |
| [`05-migration.md`](05-migration.md) | Mapping v1 data into v2, and the reconciliation oracle |
| [`06-change-log.md`](06-change-log.md) | Op format, ordering, merge, compaction, sync |
| [`07-ui-spec.md`](07-ui-spec.md) | The UI capability contract — functionality fixed, visual identity free (a refresh, not a rebuild of the v1 screens) |
| [`08-security.md`](08-security.md) | Threat model and security requirements — local listeners, the commit gate, untrusted inputs, keys, logs |

Business rules are split by area: [calendar and
scheduling](02-business-rules/01-calendar-and-scheduling.md), [postings and
balances](02-business-rules/02-postings-and-balances.md), [planning and
policies](02-business-rules/03-planning-and-policies.md), [forecast and
history](02-business-rules/04-forecast-and-history.md), plus a
[README](02-business-rules/README.md) holding the eleven cross-cutting rules that
bind them all.

---

## The thesis in one paragraph

v1's money *math* is good and well-tested; its *model* is not. Nearly every
expensive bug traces to two modelling gaps and one missing boundary. **A
scheduled occurrence has no identity**, so "counted exactly once" is
reconstructed by fuzzy matching in three separate places — twelve incidents,
including a four-PR chase of one bug across three surfaces. **Money quantities
are untyped numbers**, so a solver can converge in the wrong unit and stay
perfectly self-consistent while doing it — six incidents, including a
recommendation to set a monthly fill to −€49,200. And **the composition root owns
global state that 34 modules import**, producing a 39-module cycle in which zero
of 93 test files can test a page. Fix those three and most of v1's 24 pieces of
compensating repair machinery lose their reason to exist.

---

## The decisions

| Decision | Status |
|---|---|
| An append-only **change log** ships from day one, as the sync/undo/audit substrate | **Locked** |
| Balances fold from the **entity snapshot**, not from the log (i.e. not event sourcing) | **Locked** |
| **Occurrences are records**, with a `settledBy` foreign key | **Locked** |
| The **AI relay is a process**, built once and deployed locally or remotely | **Locked** |
| **TypeScript** and a build step | **Locked** |
| **Local-only** target, with a narrow atomic persistence port keeping cloud open | Recommended |
| A small **reactive UI layer** | Recommended |
| **Core first**, everything else re-earned | Recommended |

TypeScript was promoted from Recommended to Locked 2026-08-27: four other
documents (`01-domain-model.md`, `03-api-surface.md`,
`04-invariants-and-proof.md`, `08-security.md` §10) already assumed it, so
"recommended" was fiction.

### The reactive UI layer

Still Recommended, not Locked — the library itself is picked at the UI
milestone (M5, see "Build order" below), but the criteria are fixed now:
≲15 kB gzipped, fine-grained signals-style reactivity, no virtual-DOM
requirement, and domain code stays framework-blind (the registry boundary in
`00-architecture.md` is what keeps it swappable). Shortlist: Preact +
Signals, Lit, Solid. The final pick is recorded as a decision when M5 starts.

## Build order

| Milestone | Exit criterion |
|---|---|
| **M0** | Repo bootstrapped — monorepo layout decided, CI gate wired to the `04-invariants-and-proof.md` §3 coverage policy, dependency versions pinned — and the schema plus money/date primitives land. |
| **M1** | The engine (calendar, postings, balances) is implemented and covered by its property suite. |
| **M2** | The registry, store and change-log are wired end to end. |
| **M3** | Migration and the reconciliation oracle harness exist and produce the **first full reconciliation run** — the earliest hard evidence the rebuild matches the acceptance oracle. |
| **M4** | CLI and MCP adapters expose the registry. |
| **M5** | The UI ships and integrates against the live registry. |
| **M6** | The AI sidecar ships. |
| **M7** | Parallel run against v1 completes and v1 is retired (`05-migration.md` §4). |

`07-ui-spec.md`'s design work — capability contract, mockups, component
decisions — can start at any milestone; integration against the live
registry starts at M5.

---

## Settled questions

All four questions raised by the first draft are now decided (2026-08-26).

1. **`include: false` is a master switch.** An excluded item is inert and never
   auto-posts. v1 ignores `include` in both materialisers, so an item switched
   off still posts money — settled against that.
   → `02-business-rules/01-calendar-and-scheduling.md` §7
2. **Banking calendars are data, not code.** A six-primitive rule algebra
   (`fixed`, `easterOffset`, `nthWeekday`, `lastWeekday`, `weekdayOnOrAfter`,
   `offsetFrom`) plus weekend and observance parameters expresses any
   jurisdiction. Built-ins ship as reviewable data files with golden fixtures;
   users may override or add their own. This also resolves the verification
   problem — v1's suspect entries become a data review rather than a code audit.
   → `02-business-rules/01-calendar-and-scheduling.md` §1
3. **`set` is an input shortcut, resolved to a delta at write time.** v1 already
   does this for hand fills and names the bug it prevents — but never carried the
   fix to templates, which still persist overwriting lines. v2 resolves at the
   single command boundary.
   → `02-business-rules/02-postings-and-balances.md` §1.1
4. **Eight transaction types generalise to postings; the label stays.** All money
   movement is postings; `label` is presentation only, so the user still sees
   "Expense" or "Transfer" and filters by it, while no arithmetic branches on it.
   → `01-domain-model.md` §3.4

The last sub-question is now settled too (2026-08-27): a stored allocation
**keeps** `enteredAs: { mode: 'set', target }` as an engine-blind input echo,
guarded by a lint rule, property A10, and past-tense display copy.
→ `03-api-surface.md` §2.6. **No open questions remain.**

## Decided 2026-08-27 (architecture review)

An external review validated the spec against source (10 of 12 load-bearing
claims confirmed; two wording errata fixed in place) and settled a second
round of decisions:

1. **Occurrences are virtual until settled or skipped, and their ids are
   deterministic** — as is the id of the transaction the materialiser emits.
   This is what makes A4 hold under sync (invariant A9).
   → `01-domain-model.md` §3.7
2. **S2 restated**: the balancing identity is a definition and cannot fail;
   what is enforced is typed event shapes at the command input.
   → `04-invariants-and-proof.md` §1.1
3. **Undo inverse ops are computed and stored at commit time**; the op format
   is versioned and migrations compact first. → `06-change-log.md`
4. **`commit` takes a `baseSeq`** and the runtime rebases-and-re-executes on
   mismatch. → `00-architecture.md` §8
5. **Stress modelling is in scope from day one**, and the migration preserves
   the per-item cut data. → `02-business-rules/03-planning-and-policies.md` §12
6. **Adopted features**: payee → envelope memory (deterministic first), an
   Upcoming-bills surface, net-worth-by-month over append-only price history,
   `goal-required` template lines, URL routing + dark mode + mobile-first in
   the UI layer, CLI-cron bill reminders, and the credit-card stance
   documented.
7. **Retired**: the Goodbudget importer (no longer used). The setup wizard is
   reclassified as ordinary onboarding UX, not a compensation.
8. **A UI spec exists** (`07-ui-spec.md`): capability contract fixed, visual
   identity free — the v2 UI is a refresh, not a rebuild of the v1 screens.
9. **Registry additions** closing retention gaps: `budget.export`/`import`,
   `account.projectedInterest`, `review.closeMonth`/`reopenMonth`,
   `price.record` (append-only), `payee.setRule`, `stress.scenarios`,
   `transaction.bulkSetPayee`/`mergeToTransfer`, the AI sidecar's full job
   list including `parse_document` and the price proxy, and guest/demo mode
   via a third in-memory store adapter.
10. **`enteredAs` is kept** as an engine-blind input echo on resolved `set`
    lines — lint-enforced blindness, property A10, past-tense display copy.
    → `03-api-surface.md` §2.6

## Security review (2026-08-27)

A secure-by-design review of the full set produced `08-security.md`: a threat
model plus 27 numbered requirements (SEC1–SEC27). Most are stated hardening
of boundaries the architecture already implies — local-listener
authentication, ownership of the MCP commit gate, hostile-input validation,
the E2E key lifecycle (specified now because v1's critical defect is an
encryption lockout), and a no-secrets-in-logs rule converting v1's
cookie-logging defect into an invariant. One item is **recommended, not
locked**: SEC21, defaulting the periodic-export nudge to passphrase-encrypted
bundles. The review also confirmed the structural properties worth
protecting; they are tabled in `08-security.md` §2 so a refactor that
weakens one is recognisable as a security decision.

## Decided 2026-08-27 (post-review fixes)

A pass over the whole set closed the gaps the architecture review and a
follow-up cluster review left open:

1. **Money division defaults to half-to-even rounding to the cent** unless a
   rule states otherwise; every flagged formula (monthlyPlan Σ/12, template
   percent lines, burn/runway, emergency itemAnnual/12) now states the mode
   explicitly rather than relying on the default.
   → `02-business-rules/README.md` R3
2. **Goal progress is fully specified**: fraction clamps to `[0, 1]` (a
   zero-amount goal reads as met); `monthlyRequired` rounds up to the cent so
   a recommendation never undershoots, exact in the final month by
   construction.
   → `02-business-rules/03-planning-and-policies.md` §10
3. **`paymentDay` normalisation is one rule, stated once**: `>= 1` maps to
   `min(paymentDay, daysInMonth)`; `0` maps to month-end; anything else is
   malformed and yields no occurrences.
   → `02-business-rules/01-calendar-and-scheduling.md` §2.2
4. **`spendFlag` is quantified**: "effectively zero" means `|planned| <
   €1.00`; the dead band is `max(€1.00, 5% of planned)`.
   → `02-business-rules/03-planning-and-policies.md` §8.2
5. **Age of Money's window is one definition**: the half-open interval
   `(refDate − windowDays, refDate]`, replacing both v1 variants.
   → `02-business-rules/04-forecast-and-history.md` §6
6. **`fillDelta` clamps as a whole**, not split proportionally per fill —
   order-independent, same user-visible total.
   → `02-business-rules/04-forecast-and-history.md` §2.5
7. **`TxFilter.status` drops v1's four-way muddle** for the v2 axes:
   `status?: 'all'|'posted'|'pending'` plus an orthogonal `cleared?:
   boolean`.
   → `03-api-surface.md` §3.2
8. **Deleting a transaction that settles an occurrence deletes the
   occurrence record**: it reverts to virtual `pending` and the bill
   re-materialises as due (deterministic ids make this safe). The change-log
   ops survive — history and undo replay them — only the folded snapshot
   record does not.
   → `01-domain-model.md` §2, `06-change-log.md` §7
9. **The change-log fold keeps per-field HLCs**: a late-arriving op applies
   per field, iff its HLC exceeds that field's stored HLC — the property
   that makes "nothing in the client changes when sync is added" true.
   → `06-change-log.md` §3
10. **The migration oracle gets a machine-readable divergence manifest**:
    algorithm-shaped divergences enumerate every downstream surface they
    reach; data-shaped ones are repaired at source instead. A diff on a
    surface no entry names is Unexplained → Stop.
    → `05-migration.md` §1.3
11. **TypeScript is promoted from Recommended to Locked**, and the reactive
    UI layer's selection story is written down (criteria + shortlist).
    → this document, "The decisions"
12. **A "Build order" milestone table (M0–M7) exists**, closing the
    no-sequence gap the first draft left.
    → this document, "Build order"

## Provenance

Synthesised from eight parallel audits of the v1 codebase — product inventory,
structural and coupling analysis, correctness and test history, security and
persistence, then four deep algorithm extractions over the engine — across 152
modules, 640 commits and 93 test files. Every load-bearing claim was verified
first-hand against the source.

Five live defects found during the audit are logged in the project backlog and were
deliberately not fixed:

| Severity | Defect |
|---|---|
| Critical | Enabling encryption can permanently lock the user out (non-atomic re-key, config written last) |
| High | AI-proposed envelope transfers move no money (`from_envelope` vs `from_envelope_id`) |
| High | Session cookies written to application logs on every request |
| Medium | Forecast lens serves stale data after editing a planned budget item |
| Medium | Stress page counts dividends as expenses |
