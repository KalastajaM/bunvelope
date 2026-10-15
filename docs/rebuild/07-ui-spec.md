# Bunvelope v2 — UI Specification

**This is a capability contract, not a visual spec.** The v2 UI is a
**refresh, not a rebuild of the v1 screens** (decided 2026-08-27): the visual
identity, navigation structure, layout, component design and page grouping are
the designer's to reinvent. What is *not* free is capability — every
interaction listed in §3 must have a home somewhere in the new design, and the
acceptance rule in §6 is how "somewhere" is checked.

Two framing rules:

1. **v1 is the functional reference, never the visual one.** Where this
   document says "v1 has X", it constrains what the user can *do*, not what
   they see.
2. **No adapter computes money.** Every displayed figure comes from a registry
   query (`03-api-surface.md`); the UI's entire job is dispatch, render, and
   interaction.

---

## 1. Cross-cutting requirements — new in v2

These four are absent from v1 and are the reason the refresh happens now
rather than being retrofitted later. All four are **required**.

| Requirement | Contract |
|---|---|
| **URL routing** | Every page, and every addressable object (an envelope, an account, a transaction, a report range), has a URL. Deep links work, the back button works, a refresh lands where the user was. v1 has none of this — page state is in-memory only. |
| **Dark mode** | Full light/dark theming driven by design tokens, honouring `prefers-color-scheme` with a manual override. Chart series colours come from the token layer — the engine returns codes and numbers only (R5), which is what makes this possible. |
| **Mobile-first responsive** | Phone layouts are designed, not shrunk: touch targets, bottom-reachable primary actions, full-height sheets. v1 is a desktop layout with three breakpoints. |
| **Surfaced undo** | The op log gives general undo (`03-api-surface.md` §2.13); the UI must surface it globally (shortcut + visible affordance), not only as per-action toasts. |

## 2. Cross-cutting requirements — carried from v1

- **The lens switcher** — `today | booked | forecast` with the horizon
  selector (`eom`/3m/6m/12m/custom) — is reachable wherever balances are
  displayed, and **every** money figure on screen respects the active lens.
  Lens choice is per-device state, deliberately not synced.
- **Localisation**: three locales — English, Finnish, Dutch — with the parity
  test carried over. Locale switch re-renders in place and updates
  `html[lang]`.
- **Accessibility baseline**: keyboard operability for everything (including
  reorder — see §3), a polite live region for announcements, focus
  restoration after sheets and dialogs close, `role`/`aria` on interactive
  elements. This was real in v1; it must not regress in the refresh.
- **Formula money inputs**: every amount field accepts arithmetic
  (`1000-750`, `50,34`, `%` expressions) evaluated on blur/Enter, without
  `eval` (CSP).
- **Personalisation**: language and theme are required (above). Of v1's
  density, accent-colour and nav-layout preferences, **density** (compact vs
  comfortable) must survive in some form — it changes how much of the
  virtualised transaction list (§3.4) fits on a small screen, not just
  taste. Accent-colour and nav-layout may be redesigned or dropped; dropping
  either is a decision to record, not an omission.
- **Optimistic-conflict surfacing**: a rejected `commit` (baseSeq mismatch
  that re-execute cannot resolve — `00-architecture.md` §8) produces an
  explanatory dialog, never a silent failure or a lost edit.
- **Safety-net export**: the UI offers `budget.export` prominently and nudges
  a periodic export — the local-only user is their own DBA
  (`03-api-surface.md` §3.10).
- **Empty states everywhere**, distinguishing "fresh budget" from "no results
  for this filter", each with a CTA.
- **Perceived performance**: skeleton-first paint on load, lazy page modules,
  and a virtualised transaction list — v1's patterns are the starting point,
  not the target. Measurable floor: an interaction (tap, keystroke, filter
  change) reflects in the UI in under 100 ms, and the dashboard (§3.1) is
  interactive in under 1 s on a mid-range phone, both measured against the
  reference example budget (§3.11).

---

## 3. The capability inventory

What follows is the checklist of user capabilities, grouped by *function*
rather than by v1's pages — the refresh may regroup them freely.

### 3.1 Overview / dashboard

One `dashboard.summary` query feeds everything (`03-api-surface.md` §3.7).
Must be presentable: unallocated / left-to-assign with a one-click route into
filling; spent-this-month with days remaining; total balance with the
cleared-vs-displayed delta; savings split (savings / investment / pension,
with unrealized P&L); **credit-cards-to-pay**; Age of Money with its history
sparkline, health band and drop attribution; money cushion; annual plan
verdict (surplus/deficit); favourite accounts; category spend breakdown;
recent and upcoming activity.

### 3.2 Envelopes

Create, edit (name, category, description), archive/unarchive with undo,
favourite, reorder (see §3.10), goal (amount + date) with progress and
status, rollover policy selection, spare (safe-to-spend) and plan/spent/
balance per envelope, search and category filtering with collapsible groups,
grid/list presentation choice, the emergency-fund calculator, and the
**per-envelope health view**: projected balance chart, high/low/closing,
fill-source classification, and the recommendation list with severities and
one-click routes to act on each recommendation.

### 3.3 Accounts

Create, edit (name, type, opening balance, notes, interest tiers with
projected annual interest displayed, track-investments, pension flag),
archive, delete-when-unreferenced, favourite, reorder, search and type
filter, reconcile entry point per account, last-reconciled display,
portfolio value on investment accounts.

### 3.4 Ledger

- Entry of every event shape in `02-business-rules/02-postings-and-balances.md`
  §1, including split expenses with live remaining validation, envelope
  transfers, investment buy/sell/dividend (symbol or ISIN, units, price,
  fee), adjustments and debt payments. "Add & new" flow for batch entry.
  Payee autocomplete backed by the payee index, with the `payeeRules` default
  envelope offered (`02-business-rules/03-planning-and-policies.md` §13).
- Before/after balance preview through the active lens; unallocated-impact
  warning.
- The list: virtualised, running balances inline, actual and projected rows
  visually distinct (they arrive as **separate streams** and must remain
  distinguishable), overdue markers, post-now and skip on projected rows.
- **Search and filtering** per the closed `TxFilter` object
  (`03-api-surface.md` §3.2): text, `#tag`, amount operators, envelope,
  account, label, status, flagged, date ranges with presets. Filter state
  survives navigation; scroll position restores after an edit.
- **Bulk selection** with assign-envelope, set-date, set-payee, flag, delete,
  and merge-two-into-a-transfer.
- Flag-for-later on any row.

### 3.5 Planning

The 12-month schedule grid per plan item (per-month on/off + override
amounts), all item fields from `01-domain-model.md` §3.6 including payment
day, day type, buffer, include, emergency inclusion, stress category and
cuts, recurrence toggle; filtering (text, category, enabled, emergency,
stress); plan totals with over/under verdicts per envelope.

### 3.6 Allocation

The fill flow (add/set lines, live remaining, zero-out) — `set` resolves at
the command boundary and the UI says what delta it resolved to; template
management (mixed fixed / percent-of-plan / goal-required lines, reorder,
schedule with source envelope and since/until); apply-to-pool with scale;
declined-funding-source warnings surfaced
(`02-business-rules/01-calendar-and-scheduling.md` §4.2).

### 3.7 Upcoming bills — new surface, required

A first-class screen over `occurrence.list` / `occurrence.due`: the month's
bills with paid / pending / overdue / skipped states, settle and skip
actions, and the assistive `occurrence.unlinked` suggestions presented for
one-click confirmation (never auto-applied). This is the surface that makes
the occurrence model visible; v1 buried it in the transaction list.

### 3.8 Review, stress, reports

- Monthly review: the full `review.month` table, month navigation with
  roll-forward, consolidate-surplus per envelope, close/reopen month.
- Stress: per-scenario totals and runway with the buffer floor visible,
  per-item cut editing in place, scenario detail.
- Reports: all eight aggregates (`03-api-surface.md` §3.6) over range
  presets, including **net worth by month**; overspent highlighting; every
  chart themed via tokens (no hardcoded series colours — they no longer
  exist in engine output).

### 3.9 Import, reconcile, investments

- Import: file pick → mapping (auto-detected, correctable, saveable, with
  saved mappings offered), AI parse hand-off for receipts/PDFs, proposal
  review with graded duplicates and pre-assigned envelopes, statement-balance
  check result, commit of the approved subset.
- Reconcile: the one-command flow (`account.reconcile`) as a UI session —
  statement date and balance, converging cleared total, inline add, optional
  gap adjustment, dry-run preview before commit.
- Investments: holdings with cost basis, unrealized/realized P&L,
  distributions, oversold and stale-price warnings, override management,
  price refresh (via the sidecar) and manual price entry, unmapped-row
  mapping to symbols, allocation and invested-over-time views.

### 3.10 Reordering

Envelopes, accounts, categories and template lines reorder by **drag, touch,
and keyboard, with parity** — every reorder achievable by mouse is achievable
by keyboard, with announcements. Order is `sortKey`-backed
(`01-domain-model.md` §5).

### 3.11 Onboarding and help

First-run flow: budget name + currency → optional import → paste-your-
balances (rendered as opening adjustments) — ordinary commands underneath
(`03-api-surface.md` §5). Guest/demo mode with the example budget and
start-empty. The concept explainers (envelopes, unallocated, age of money,
reconciling, cost basis, …) carry forward as content; the guided tour is
**recommended but redesignable** — some interactive first-use orientation
must exist.

### 3.12 The AI surface

The ⌘K agent (streaming, tool status, attachments, cost meter) and the
insight cards, per `00-architecture.md` §9.1. The approval surface **shows
the ops** a proposal would commit — a diff, not a summary — because approval
fatigue is the security boundary. Consent, per-feature toggles and
dismissals are per-user runtime state with a management UI.

---

## 4. What is explicitly free

Navigation structure and grouping; visual identity (typography, colour,
spacing, iconography — dark mode aside, which is required); component
library and interaction patterns; which capabilities share a screen; the
copy, provided every i18n key exists in all three locales; whether v1's
Tweaks panel survives as such. **Freedom ends where a §3 capability loses
its home.**

## 5. What is explicitly gone

The repair sheet, the stale-link dialog, the permanent invariant console and
the tombstone plumbing have no UI because they have no registry surface
(`03-api-surface.md` §5). The status area may still surface
`invariants.check` results during import/migration — as a flow, not a
fixture.

## 6. Acceptance

Every §3 bullet maps to at least one e2e or golden test, or to a manual
checklist item reviewed before the v1 retirement decision
(`05-migration.md` §4). A capability with no mapped home fails the review —
that is the entire enforcement mechanism, and it is deliberately boring.
