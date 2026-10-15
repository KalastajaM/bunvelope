# S09 — Source-funded template: nets to zero, displays once, drains visibly

Pins `../../02-business-rules/01-calendar-and-scheduling.md` §4.2 and §6, and
the negative-`monthlyFill` rule of
`../../02-business-rules/04-forecast-and-history.md` §3 — the disconnected
Salary-Buffer regime, the doubled display total, and the phantom
self-cancelling drawdown.

## Setup

- Today = `2026-05-10`.
- Envelopes `Food`, `Transport`, and `Buffer` (the funding source).
  `Buffer` balance: €1,800.00.
- Template `Drawdown`, monthly on the 1st, `sourceEnvelopeId: Buffer`,
  `sourceSince: 2026-05-01`. Add-lines: `Food +€100.00`,
  `Transport +€50.00`.
- The May fill has posted (2026-05-01).

## Expected

The posted May fill's postings (all envelope-axis):

- `Food +100.00`, `Transport +50.00`, `Buffer −150.00`.
- Σ envelope postings = 0 → **unallocated does not move**. No account leg.

Display (§6): `fillDisplayTotal` excludes the funding-source negative →
**€150.00**, never 300.00 (the abs-sum) and never a `−0.00` rendering.

Balances after May 1: `Food` +100.00, `Transport` +50.00, `Buffer`
1,800.00 − 150.00 = **€1,650.00**.

`fillSource`/`monthlyFill` for `Buffer` (12-month projection, monthly
sourced fills in every whole month):

- Monthly sum of lines landing on `Buffer` = **−€150.00/month** — kept
  negative and reported: this envelope is scheduled to *lose* 150.00/month.
- Projection: `Buffer` declines by 150.00/month. The window (asOf
  2026-05-10 + 12 months → end 2027-05-09) contains twelve fills, Jun 2026
  through May 2027: 1,650.00 − 12×150.00 = **−€150.00** = the projected low.
  The health view shows a depleting buffer that runs out — never a flat line
  (v1's abs-summed history synthesised a phantom +150.00 that exactly
  cancelled the drain).

Decline cases (each leaves an ordinary unallocated-funded fill, surfaced as a
configuration warning):

- `sourceSince: 2026-06-01` and scheduleDate 2026-05-01 → May's fill posts
  **without** the source leg (raw schedule date compared, so a
  `prev-work-day` adjustment cannot skip the first drawdown month).
- Adding `Buffer +€25.00` as a target line → source declined (source is also
  a target).
- Any `set`-mode line in the template → source declined.

## Failure this pins

The silent-disconnect regime: weeks of fills that "looked funded while
leaking from unallocated," a buffer that never depleted, and free-to-allocate
absorbing the draw as phantom overallocation. The snapshot must pin all three
figures at once: unallocated unmoved, display total 150.00, `Buffer` monthly
−150.00.
