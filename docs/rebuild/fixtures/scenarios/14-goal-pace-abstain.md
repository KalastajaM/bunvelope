# S14 — Goal pace: abstain beyond a year; `monthlyRequired` rounds up

Pins `../../02-business-rules/03-planning-and-policies.md` §10: the goal 18
months out at 0% that v1 reported green, the up-rounding of the
recommendation, and the 1-month floor.

Today = `2026-03-01` throughout.

## Case A — 18 months out, no `startedAt`: abstain

Envelope `Car`, goal `€1,200.00` due `2027-08-31`, balance €0.00, no
`startedAt`.

- `daysRemaining` = wholeDaysBetween(2026-03-01, 2027-08-31) = 365 + 183
  = **548** (2027 day-of-year: Mar 1 = 60, Aug 31 = 243).
- 548 > 365 → `expectedFraction` = **null** → status **`early`** (muted, no
  verdict). Never `on-track` (v1's negative-ramp artifact made 0% "on
  track").
- `monthsRemaining` = max(1, 548 / 30.4375) = 18.0041…
- `monthlyRequired` = round-up-to-cent(1,200.00 / 18.0041…) =
  round-up-to-cent(66.6514…) = **€66.66** — up, never 66.65, which would
  undershoot the goal.

## Case B — same goal with `startedAt: 2025-09-01`

Span = days(2025-09-01 → 2027-08-31) = 365 + 365 = **730**? — 2025-09-01 →
2026-09-01 is 365, 2026-09-01 → 2027-08-31 is 364 → **729**. Elapsed =
days(2025-09-01 → 2026-03-01) = **181** (Sep 30 excl start? whole-day diff:
Sep→Mar = 30+31+30+31+31+28 = 181).

- `expected` = clamp01(181/729) ≈ 0.2483. Balance 0 → fraction 0 <
  expected → **`behind`**. The exact-comparison decomposition applies:
  `balance × totalDays >= goal.amount × elapsedDays` → `0 ≥ 1,200.00×181` is
  false.
- With balance €300.00: 300.00 × 729 = 218,700 vs 1,200.00 × 181 = 217,200
  (cent-scaled both sides) → 218,700 ≥ 217,200 → **`on-track`** — decided
  without ever forming a rounded fraction.

## Case C — 3 days out: the floor

Goal `€300.00` remaining (balance 0), due `2026-03-04`.

- `daysRemaining` = 3 → `monthsRemaining` = max(1, 0.0986) = **1** →
  `monthlyRequired` = **€300.00** — the whole remainder, not ten times it.

## Case D — degenerate guards

- Goal amount €0.00 → `fraction` = 1, status `reached` (trivially met).
- Past-due goal (`daysRemaining` < 0) → `behind`; `monthlyRequired` uses the
  1-month floor, never divides by a negative.
- `startedAt` on or after the deadline → ignored (abstain path), never a
  zero/negative span division.
