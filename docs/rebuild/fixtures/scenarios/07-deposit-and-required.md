# S07 — `calcDepositAndRequired` worked cases

Pins `../../02-business-rules/03-planning-and-policies.md` §4 exactly as
stated there, so the golden runner and the spec's own worked table can never
drift apart.

`roll[1]` is the month under review; `roll[2..12]` the next eleven.

## Cases

### A — Flat schedule

`roll` = €100.00 every month, buffer 0.

- annual = 1,200.00 → deposit = **€100.00** (ceil of an exact division).
- Every shortfall C[k] − C[1] − (k−1)×100.00 = 0 → required = **€0.00**.

### B — Flat schedule with a buffer

Same `roll`, buffer €500.00 → deposit **€100.00**, required **€500.00**
(clamped-at-zero schedule need, plus the buffer).

### C — A one-off in month 2 (the €183.33 case)

`roll` = [100.00, 300.00, 100.00 × 10], buffer 0.

- annual = 1,400.00 → deposit = ceil(1,400.00/12) = ceil(116.666…)
  = **€116.67** — rounds UP; €116.66 would leave a compounding shortfall.
- k = 2 binds: C[2] − C[1] − 1×deposit = 400.00 − 100.00 − 116.67
  = **€183.33** = required.
- Check no later k binds: k = 3 gives 500.00 − 100.00 − 233.34 = 166.66;
  k = 12 gives 1,400.00 − 100.00 − 1,283.37 = 16.63. Max is at k = 2.

### D — Nothing scheduled, buffer only

`roll` all zero, buffer €1,200.00 → deposit **€0.00**, required **€1,200.00**.
The zero-clamp precedes the buffer add, so the floor is honoured even when
the schedule needs nothing.

### E — Validation

Any negative `roll` entry → **validation error at the boundary** (v2), never
a negative deposit (v1's arithmetic accepted it).

## Notes for encoding

These are pure-function cases (`execute`-level, no ledger); encode as direct
command tests as well as golden inputs. Cents throughout: 116.67 = `11667n`.
