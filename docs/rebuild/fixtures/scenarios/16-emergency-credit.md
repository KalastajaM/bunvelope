# S16 — Emergency fund: current balances credit, clamped rows stay listed

Pins `../../02-business-rules/03-planning-and-policies.md` §7: the €800
groceries envelope that credited €0 before the fix, annualised essentials,
and the clamped-but-listed rule.

Today = `2026-09-10`. `creditMode: 'flagged'` (default), `durationMonths: 3`,
emergency envelope `Emergency` with `emergencyBuffer: €0.00`.

## Setup

- Plan item `Groceries` — expense `€800.00`, all 12 months,
  `includeInEmergency: true`, envelope `Groceries`.
- Plan item `Car service` — expense `€600.00`, **only November** active,
  `includeInEmergency: true`, envelope `Car`.
- Plan item `Streaming` — expense `€15.00` monthly,
  `includeInEmergency: false`, envelope `Fun`.
- Balances today: `Groceries` **€800.00** (with €800.00 of planned September
  spend still ahead — that is the point), `Car` **−€50.00**, `Fun` €120.00,
  `Emergency` €500.00.

## Expected

Monthly essentials — annualised, never this-month:

- `Groceries`: 9,600.00/12 = **€800.00**
- `Car service`: 600.00/12 = **€50.00** — a November one-off contributes
  50.00/month, not 0 in October and 600.00 in November. (`essentials ×
  duration` must not multiply a yearly invoice by 3 merely because the
  current month contains it.)
- `Streaming`: excluded (not flagged).
- `monthlyEssentials` = **€850.00**.

Credit (current balances, flagged mode):

- `Groceries` +800.00 — full current balance, despite the €800.00 of planned
  September spend (in an emergency this month's plan is pausable). The v1
  regression credited €0 here.
- `Car` −50.00 → clamped to **0**, but **still listed** with a `clamped`
  flag — muted, not silently dropped.
- `Fun`: not listed (no flagged item). `Emergency` never credits itself.
- `credit` = **€800.00**.

Requirement:

- `required` = max(0, 850.00 × 3 − 800.00) + 0 = 2,550.00 − 800.00 =
  **€1,750.00**.
- Coverage: `Emergency` balance 500.00 → shortfall €1,250.00.

## Variant — `creditMode: 'all'`

`Fun` now credits 120.00 → credit = 920.00 → required = max(0, 2,550.00 −
920.00) = **€1,630.00**. Archived envelopes still never credit.
