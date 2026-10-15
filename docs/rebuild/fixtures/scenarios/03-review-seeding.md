# S03 — The −€2,550 review: as-of balances, never booked

Pins `../../02-business-rules/03-planning-and-policies.md` §8.3, v1's most
expensive contract: the review's balance must be as-of the reference date. In
v2 the review resolves its own balances from its lens, so the trap is gone —
this scenario proves the numbers, not the seeding.

## Setup

- Today (reference date) = `2026-09-10`.
- Envelope `Rent`: as-of balance today **€2,300.00** (funded by past fills).
- One future-dated, hand-entered September transaction: 2026-09-25 expense
  **€2,300.00** from `Rent` (booked, not posted-as-of-today; settles nothing).
- Plan for September (`roll[1]` + booked extras landing this month):
  **€2,550.00**. Encode as: plan items totalling 250.00 for September plus the
  2,300.00 booked extra (a hand-entered future debit is added into the
  schedule per §5 — it is dated in the future, inside the window, settles
  nothing, and is not projected).
- Actual spend so far this month: **€0.00**.

## Expected review row for September

| Column | Value | Derivation |
|---|---|---|
| `balance` | **2,300.00** | as-of 2026-09-10 — the future 09-25 row is excluded |
| `actual` | 0.00 | nothing posted on or before today |
| `scheduled` | 2,300.00 | the future-dated booked row |
| `planned` | 2,550.00 | roll[1] 250.00 + booked extra 2,300.00 |
| `remaining` | 2,550.00 | max(2,300.00, 2,550.00 − 0.00) |
| `projected` | **−250.00** | 2,300.00 − 2,550.00 |

The wrong (v1, booked-seeded) chain, which must **not** appear: balance
0.00 (2,300 − 2,300 with the future row already subtracted), projected
0.00 − 2,550.00 = **−2,550.00** — the future row deducted twice.

## Also asserted

- Roll-forward (§8.4): October's opening = September's `startNext`
  = projected + deposit, with the reference date held fixed at 2026-09-10.
- `spendFlag` for September = **`under`**: planned 2,550.00 → band
  = max(1.00, 5% × 2,550.00) = 127.50, and actual 0.00 < 2,550.00 − 127.50.
  (Stated exactly so the snapshot pins §8.2's band arithmetic too.)
