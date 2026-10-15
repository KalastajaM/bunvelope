# S11 — `set` resolves at write time; shuffling changes nothing

Pins `../../02-business-rules/02-postings-and-balances.md` §1.1 and
invariants A2/A6: the onboarding-`set`-wipes-a-future-expense bug, and the
order-dependence that made v1's balance walk a caller obligation.

## Setup

Envelope `Household`, balance €0.00. Three entries, **in this entry order**
(deliberately not date order):

1. Entered first: expense **−€30.00** dated `2026-06-15` (future-dated,
   booked).
2. Entered second, on 2026-05-01: fill line `set Household to €400.00`,
   dated `2026-05-01`.
3. Entered third, on 2026-05-20: fill line `add Household +€50.00`, dated
   `2026-05-20`.

Today = `2026-05-25`.

## Expected

Write-time resolution of entry 2: `balanceAsOf(2026-05-01)` sees only rows
**dated** ≤ 2026-05-01 — the June expense is excluded by date, not by entry
order — so the stored posting is `400.00 − 0.00` = **`Household +400.00`**,
an ordinary delta. `enteredAs: { mode: 'set', target: 40000n }` is kept as an
engine-blind echo (A10); stripping it changes no number below.

Balances:

- `today` lens (≤ 2026-05-25, posted): 400.00 + 50.00 = **€450.00**
- `booked` lens: 400.00 + 50.00 − 30.00 = **€420.00**

A2 — shuffle: any permutation of the stored transaction array yields the
same balances in every lens. There is no assignment left in the ledger, so no
sort precondition exists.

A6 — idempotence: `normalize(normalize(ledger)) === normalize(ledger)`; in
particular re-running write-boundary normalisation must **not** re-resolve
the stored delta (there is no `set` in storage to resolve).

The v1 failure (must not reproduce): applying the `set` at its position in
entry order wiped the already-recorded future expense — the user's −30.00
silently vanished; and `add 50 then set 400` vs `set 400 then add 50` gave
400 vs 450 depending on sort.

## Also pinned

- Folding asymmetry is gone: with resolution at write, both entry orders
  above produce +400.00 and +50.00 deltas and every ordering sums to 450.00
  (as-of today).
- A stored fill line with `set` mode is **unrepresentable** — the command
  boundary is the only path (S2 shape conformance).
