# S13 — The dividend rule, on every surface at once

Pins `../../02-business-rules/03-planning-and-policies.md` §1.1 and §12, and
the posting shape of `../../02-business-rules/01-calendar-and-scheduling.md`
§3.3: a dividend is shaped like an investment recurrence but behaves as
income — and one v1 surface (Stress) forgot.

## Setup

- Accounts: `Checking` (cash), `Broker` (investment). Envelope `Dining`.
- Plan item `ACME dividend` — kind `investment`, direction `dividend`,
  `€25.00` quarterly (Mar/Jun/Sep/Dec), envelope `Dining` (optional, set),
  cash account `Checking`, recurring.
- Plan item `Rent` — expense `€900.00` monthly.
- Today = `2026-06-20`; the June dividend materialised on 2026-06-15.

## Expected

Postings of the materialised June dividend:

- `Checking +25.00`; `Dining +25.00`; **`Broker` does not move** — the cash
  came from outside the budget.

Spend: `envelopeSpend(dividendTx, Dining)` = **€0.00** (dividends are not in
the spending set; the review must not count a dividend as a debit).

Annual totals (§1): `ACME dividend` is **income-like** →
`income` includes 4 × 25.00 = **€100.00**; `expense` = 12 × 900.00 =
€10,800.00; the dividend appears in no expense-only path (expense calendar,
buffers, emergency essentials, dynamic templates).

Stress scenarios (§12) — the v1 live defect inverted: with scenario totals
over these two items,

- `income` = **€100.00**, `expense` = **€10,800.00**,
- `burn` = round-half-to-even((10,800.00 − 100.00)/12) = 10,700.00/12
  = 891.666… → **€891.67/month**.
- v1's wrong partition (dividend as expense) gives (10,900.00 − 0)/12 =
  908.33 — overstated burn, understated runway. Must not appear.
- Runway with `cashOnHand` €8,916.70, `reservedCash` 0:
  8,916.70 / 891.67 = **10.0 months** (displayed to one decimal).

Age of Money: dividend income enters the FIFO queue as income? **No** — AoM
pairs *posted income* against spending; a dividend posts `Checking +25.00`
as investment-kind, and §6 ignores only transfers and adjustments. Encode
the chosen answer: a dividend **is** external money arriving and enters the
queue. (Stated here so the implementation decision is pinned; if M1 decides
otherwise, this line is the place the disagreement surfaces.)
