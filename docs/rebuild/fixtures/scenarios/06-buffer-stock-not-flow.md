# S06 — Buffer is a floor, never annualised: €100.00, not €129.53

Pins `../../02-business-rules/03-planning-and-policies.md` §3 with the exact
reported numbers: a €1,200/yr item carrying a €354.40 buffer overfunded its
envelope by buffer/12 every month, forever, while the reserve demanded the
same buffer again.

## Setup

- Envelope `Insurance`.
- Plan item `Insurance` — expense `€100.00`, **all 12 months active**, no
  overrides, `buffer: €354.40`, `include` default.
- Template line: percent-of-plan **100%** (10,000 bp) on `Insurance`.

## Expected

Annual plan (§1): `annualForItem` = 12 × 100.00 = **€1,200.00** — the buffer
is *not* in it.

Monthly plan (§2): 1,200.00 / 12 = **€100.00** (half-to-even, exact here).

Template resolution (§6): the percent line resolves against `monthlyPlan` →
**€100.00**. Never 129.53 (= (1,200.00 + 354.40)/12).

Funding math (§4) with `roll` = 100.00 × 12, buffer 354.40:

- `annual` = 1,200.00; `deposit` = ceil(1,200.00/12) = **€100.00/month**.
- Shortfall at every k: C[k] − C[1] − (k−1)×100.00 = 0 → schedule `required`
  = 0.
- `required` = 0 + |354.40| = **€354.40** — the buffer enters exactly once,
  as a stock.

Emergency essentials (§7, if `includeInEmergency` is set on this item):
contribution = round-half-to-even(1,200.00/12) = **€100.00/month** — again no
buffer.

## The double-count this forbids

The v1 failure had the same €354.40 simultaneously: (a) annualised into the
fill (129.53 − 100.00 = 29.53/month ≈ 354.40/yr of overfunding), and (b)
demanded as reserve. Total effect ≈ 2× the buffer. The snapshot must show the
buffer's entire footprint is the single `required` term — monthly fill 100.00,
required 354.40, and the envelope's projected balance growing by €0.00/month
net once the reserve is funded and bills post.
