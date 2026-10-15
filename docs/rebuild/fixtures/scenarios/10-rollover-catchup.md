# S10 — Rollover catch-up: three closed months, oldest first

Pins `../../02-business-rules/03-planning-and-policies.md` §9: v1 processed
exactly one month back, so a three-month absence silently dropped two months
of sweeps; and out-of-order processing judges a later month against a balance
that has not absorbed the earlier sweep.

## Setup

- Today = `2026-07-05`. Last processed close: March 2026.
- Envelope `Groceries`, policy `zero-monthly`, balance €0.00 entering April.
- Posted history (fills on the 1st, spends mid-month):
  - April: +€100.00 fill, −€40.00 spend
  - May: +€100.00 fill, −€70.00 spend
  - June: +€100.00 fill, −€10.00 spend

## Expected

Month-close materialisation emits **three** sweeps, oldest first, each
evaluated on the posted-only lens as of that month's last day, *including the
earlier sweeps already emitted*:

| Close | Balance at month end | Sweep posted | Dated |
|---|---|---|---|
| April | 0 + 100.00 − 40.00 = 60.00 | −€60.00 | **2026-04-30** |
| May | (60.00 − 60.00) + 100.00 − 70.00 = 30.00 | −€30.00 | **2026-05-31** |
| June | 0 + 100.00 − 10.00 = 90.00 | −€90.00 | **2026-06-30** |

- Envelope after catch-up: **€0.00**. Unallocated gains 180.00 total.
- Each sweep is dated the **last day of its closing month**, so an
  April report run after the catch-up already contains April's sweep.
- Idempotency: each sweep is an occurrence record; running month-close again
  emits nothing (A5). No `rollover:envId:YYYY-MM` string key exists.
- Payee/labels: the sweep transaction carries a **code**, not English text
  (R5).

The wrong-order counterexample (must NOT happen): processing June first
evaluates 60.00 + 30.00 + 90.00 = 180.00 and sweeps −180.00 dated 06-30, then
finds April and May already zeroed — one sweep, wrongly dated, wrongly sized
per month.

## Variant — `cover-from-unallocated`

Same months but spends 140.00 / 70.00 / 10.00 and policy
`cover-from-unallocated`:

- April ends 0 + 100.00 − 140.00 = −40.00 → posting **+€40.00** (to exactly
  zero), dated 04-30.
- May ends 0 + 100.00 − 70.00 = +30.00 → **nothing** (cover ignores positive
  closes).
- June ends 30.00 + 100.00 − 10.00 = +120.00 → nothing.
