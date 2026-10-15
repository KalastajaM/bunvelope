# S04 — The −€49,200 trim: bounded by the fill, unit declared

Pins `../../02-business-rules/04-forecast-and-history.md` §5.3 and invariant
A7: a €50,000 cushion against an €800/month fill must produce a trim of at
most the fill itself, in `CentsPerMonth`, never a balance-sized number.

## Setup

- Today = `2026-06-15`. Projection window 12 months. Floor = 0 (v2.0
  constant).
- Envelope `Cushion`: balance **€50,000.00**.
- Template fill `Cushion +€800.00`, monthly on the 1st, add-mode, every month
  funded → `fillSource: scheduled`, `monthlyFill` = **€800.00/month**.
- No outflows of any kind.

## Expected

The projection only ever rises: low (incl. day zero) = **€50,000.00**.

The overfunded-trim rule proposes a fill reduction:

- Search bound = min(low − floor, monthlyFill) = min(50,000.00, 800.00)
  = **€800.00/month** — the entire fill is the most "fill this envelope less"
  can mean.
- Verified bisection result: trimming the full €800.00/month keeps every
  projected balance ≥ 50,000.00 ≥ floor, so the recommendation is
  `amount = 800.00`, `unit = CentsPerMonth`.
- A7 check: applying the recommendation (fillDelta = −800.00/month) yields a
  projection whose every month's fill total is exactly 0.00 — the stated
  effect equals the actual effect.

Must **not** appear: any candidate or result derived from `low − floor` alone
(≈ 50,000.00, which saturates the predicate — §2.5 clamps the month's fills at
−Σ fills — and would "converge" on the search bound).

## Saturation guard (§5.1)

`solveMaximum` must not shortcut on `test(hi)`: with `hi` above 800.00 the
predicate is satisfied for every larger value because the clamp freezes the
projection. The verified-step contract means the returned amount is still
800.00, not `hi`.

## Variant — uneven fills, whole-total clamp (§2.5)

Same envelope but two fills per month: +€1,000.00 on the 1st and +€200.00 on
the 15th (`monthlyFill` = 1,200.00/month). A caller applies
`fillDelta = −1,200.00/month`:

- Clamp is on the total: −1,200.00 ≥ −Σ(1,000 + 200) → unclamped.
- Even split: −600.00 per fill → the two projected fills become +400.00 and
  −400.00. The month's fill **total** changes by exactly −1,200.00 — the
  label and the arithmetic agree (the per-fill negative is the accepted
  consequence recorded in §2.5).
