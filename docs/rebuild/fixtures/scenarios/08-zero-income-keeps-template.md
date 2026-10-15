# S08 — Zeroing an income must not take its month's allocation down

Pins `../../02-business-rules/01-calendar-and-scheduling.md` §2.2 (the
sub-cent drop gate must not exist) and §4 (templates fire on their own
calendar): the v1 bug where zeroing a scheduled income silently emitted no
allocation at all.

## Setup

- Calendar `FI`. Today = `2026-10-05`.
- Account `Checking`. Envelopes `Food`, `Rent`.
- Plan item `Salary` — income `€3,000.00`, monthly, `paymentDay: 25`,
  `dayType: prev-work-day`, recurring, account `Checking`. October's schedule
  cell carries **`override: 0`** (unpaid leave this month).
- Template `Payday allocation`, monthly on the 25th (`prev-work-day`):
  add-lines `Food +€400.00`, `Rent +€900.00`. No funding source.

## Expected

Occurrence generation for October:

- The `Salary` occurrence for October **exists** with `amount: €0.00` —
  generated, visible in the schedule (the month is configured at zero, which
  is different from not configured).
- The template's October occurrence exists independently — templates have
  their own calendar; no income event is consulted.

Materialisation on 2026-10-23 (Oct 25 is a Sunday; `prev-work-day` →
2026-10-23, a working Friday in FI):

- `Salary`: **no transaction** — a zero-amount occurrence is excluded from
  materialisation (nothing to post), but is not deleted or skipped.
- Template fill: **posts in full** — one fill transaction with envelope
  postings `Food +400.00`, `Rent +900.00`, no account leg, unallocated
  −1,300.00. Balances are not consulted (§4.3): if unallocated goes
  negative, it posts anyway and the product displays overallocation.

November (no override): both post — income €3,000.00 on its adjusted date and
the fill €1,300.00.

## Failures this pins

- v1's amount gate (`< 1 cent` → drop) lived inside the shared walker, so a
  zeroed income dropped its occurrence *and* the fill emitted inside the same
  loop — the paycheck took the budget down with it.
- The fill must never be conditional on the income's amount, presence, or
  posting success.
