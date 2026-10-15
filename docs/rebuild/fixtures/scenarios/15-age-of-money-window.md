# S15 — Age of Money: one half-open window, starved samples null, DST-safe spans

Pins `../../02-business-rules/04-forecast-and-history.md` §6 and §6.1: the
window that v1 measured two different ways in one call, and the day-span
arithmetic that was wrong on every DST-observing machine while CI stayed
green.

`windowDays` = 30, `refDate` = `2026-04-15`. The window is the half-open
interval **(2026-03-16, 2026-04-15]** — Apr 15 included, Mar 16 excluded.

## Setup (posted rows only)

- 2026-03-01: income **+€1,000.00**.
- 2026-03-16: expense **−€100.00** (dated exactly on the excluded lower
  bound).
- 2026-03-20: expense **−€200.00**.
- 2026-04-10: expense **−€100.00**.
- Plus one account transfer €500.00 on 2026-03-25 and one account adjustment
  +€40.00 on 2026-04-01 — both **ignored** (internal shuffles).

## Expected

FIFO walk (interpretation pinned here deliberately): *every* posted expense
consumes the income queue in date order; only expenses **inside the window**
contribute recorded (amount × age) samples.

- 03-16 expense: consumes €100.00 of the 03-01 deposit, **records nothing**
  (on the excluded bound).
- 03-20 expense: consumes €200.00, age = wholeDaysBetween(03-01, 03-20)
  = 19 days → recorded.
- 04-10 expense: consumes €100.00, age = **40** days → recorded. The span
  03-01 → 04-10 crosses Europe's spring-forward (2026-03-29); the
  calendar-day rule gives exactly 40 in every timezone of the matrix — a raw
  `floor(ms/86,400,000)` gives 39 in `Europe/Helsinki` and is the pinned
  failure.
- Age of Money = (200×19 + 100×40) / 300 = 7,800/300 = **26 days** (whole
  days, half-to-even). Health band: **yellow** (14–29).

## Starved sample

Variant: same ledger but the income is **+€350.00**. The 03-16 and 03-20
expenses consume 300.00; the 04-10 expense (recorded, in-window) needs
€100.00 with only €50.00 left → the queue runs dry mid-expense → **Age of
Money = null** for the whole sample. Spending exceeding received income is
not a number, it is an absence.

## Window discipline

The money-cushion spend window in the same call uses the **same** half-open
interval — never `windowDays + 1`. Encode one assertion comparing the two
windows' row sets on a fixture where the extra day would matter (an expense
dated exactly 2026-03-16).
