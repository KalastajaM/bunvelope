# S01 — Quarterly bill, paid early by hand, in a DST month, with a template fill and a rollover

The canonical A4 narrative from `../../04-invariants-and-proof.md` §2.2: every
mechanism that can double-count one obligation is active at once, and the
obligation must be counted exactly once on every surface.

## Setup

- Calendar `FI`. Today = `2026-03-20`. (Europe's DST spring-forward falls
  inside the month, 2026-03-29 — irrelevant to every expected value, which is
  the point.)
- Account `Checking`, opening balance `€1,000.00`.
- Envelope `Utilities`, rollover policy `zero-monthly`, balance zero entering
  March (any earlier remainder was swept at the prior month close — that is
  what the policy does).
- Plan item `Water` — expense, `€150.00` quarterly (active Mar/Jun/Sep/Dec),
  `paymentDay: 15`, `dayType: exact`, recurring, envelope `Utilities`,
  account `Checking`.
- Template `Monthly fill`, own calendar, monthly on the 1st: one add-line
  `Utilities +€60.00`, no funding source.
- 2026-03-01: the scheduled fill posted — `Utilities +60.00` → balance 60.00.
- 2026-03-02: a hand adjustment `Utilities +€100.00` (catch-up top-up)
  → balance 160.00.
- 2026-03-10: the user hand-enters the water payment early:
  expense `€150.00`, `Checking`, `Utilities`. The assistive matcher
  (`../../02-business-rules/04-forecast-and-history.md` §4.2) finds exactly one
  candidate (amount exact, |10 − 15| ≤ 10 days, mutual uniqueness holds) and
  the user accepts, settling the March occurrence with `settledBy` = that tx.

## Expected

Occurrence identity:

- Exactly **one** occurrence exists for (`Water`, `2026-03-15`); status
  `settled`, `settledBy` = the 03-10 transaction, deterministic id.
- Running `occurrence.materializeDue({ asOf: 2026-03-20 })` posts **nothing**
  (A5: the occurrence is settled; re-running is a no-op).

Balances after 03-10 (booked lens = today lens here, nothing future-dated):

- `Utilities` = 60.00 + 100.00 − 150.00 = **€10.00**
- `Checking` = 1,000.00 − 150.00 = **€850.00** (the fill has no account leg)
- Unallocated = 850.00 − 10.00 = **€840.00**

Exactly-once on every surface (the three-surface user journey of
`../../04-invariants-and-proof.md` §2.7 spec 3):

- Envelope card: March spend for `Utilities` = **€150.00** (once).
- Forecast lens for March: the `projected` stream contains **no** pending
  `Water` occurrence; the €150.00 appears only as the real 03-10 row. March
  envelope outflow in the projection = 150.00, not 300.00.
- Transaction list: one €150.00 row, marked as settling the occurrence.

Rollover at March close (evaluated on the posted-only lens as of 03-31):

- Closing balance 10.00 > 0 → `zero-monthly` sweeps **−€10.00**, posting dated
  **2026-03-31**, envelope → 0.00, unallocated +10.00 → 850.00.
- The sweep is an occurrence-recorded event: re-running month-close is a
  no-op (A5), and no `rollover:…` string key exists anywhere.

June preview: the forecast lens shows the next pending occurrence at
`2026-06-15` for €150.00 — settling March did not consume June.

## Failure this pins

v1's twelve-incident class: hand payment + key-only dedup counts the bill
twice (once real, once forecast), and deleting either copy resurrects the
other. The whole-vector snapshot must show 150.00 exactly once in every
surface simultaneously.
