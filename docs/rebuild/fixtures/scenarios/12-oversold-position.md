# S12 — Oversold position: no invented profit

Pins `../../02-business-rules/02-postings-and-balances.md` §4.1 with its own
worked case, plus the cash-symmetry and same-day ordering rules around it.

## Setup

- Account `Broker` (type `investment`), account `Checking`, envelope
  `Investing`.
- 2026-02-10: BUY 50 units of `ACME` @ €10.00, fee €0.00 → cash €500.00.
  Postings: `Checking −500.00`, `Broker +500.00`, `Investing −500.00`.
- 2026-04-20: SELL 100 units of `ACME` for total cash €1,000.00 (fee already
  netted). Postings: `Broker −1,000.00`, `Checking +1,000.00`,
  `Investing +1,000.00`.

## Expected holdings for (`Broker`, `ACME`)

- `removed` = min(100, 50) = 50
- `costRemoved` = 500.00 × 50 / 50 = 500.00 (single expression, half-to-even)
- `proceeds` = 1,000.00 × (50 / 100) = 500.00
- `realized` = 500.00 − 500.00 = **€0.00** — not the €500.00 of invented
  profit the pre-fix behaviour reported.
- `units` = 0; `costBasis` snapped to **0** (closed position).
- `oversoldUnits` = **50** — surfaced as a data problem, never silently
  added in.

Account balances (cash-symmetric legs): `Checking` −500.00 + 1,000.00 =
+500.00 net; `Broker` +500.00 − 1,000.00 = **−€500.00** — itself a visible
signal of the missing transferred-in buy.

Envelope: `Investing` −500.00 + 1,000.00 = **+€500.00**. Spend
(`envelopeSpend`): the buy spends 500.00; the **sell spends zero** (money
returning is not spending).

## Same-day ordering guard

Variant: both legs dated `2026-04-20`, buy entered first. The holdings walk
sorts date-ascending **with the explicit index tiebreaker**, so the buy
applies before the sell and the result is identical to the two-date case.
Relying on engine sort stability (v1) is not acceptable — a same-day sell
processed first would zero the position and inflate `oversoldUnits` to 100.

## Unknown direction

A posting with `direction: 'frobnicate'` is **rejected at the boundary**
(R9), never defaulted to `'buy'`.
