# S02 — The €183.60 property tax: exact settling, no pooled netting

The reported shape from `../../02-business-rules/04-forecast-and-history.md`
§4.1/§4.3: an envelope holding €122.40 against a €183.60 October bill funded by
a €30.60/month fill that lands exactly square. v1 reported spare **−183.60**
and October out **−367.20**; and after fix #117 three unrelated purchases could
silently erase the unpaid bill.

## Setup

- Calendar `FI`. Today = `2026-08-20`.
- Envelope `Property Tax`, policy `carry`, floor 0.
- Plan item `Property tax` — expense `€183.60`, active Apr and Oct,
  `paymentDay: 15`, `dayType: exact`, recurring.
- Template fill `Property Tax +€30.60`, monthly on the 1st.
- History: the April 2026 bill posted and settled normally; fills have landed
  May–Aug. Balance today = 4 × 30.60 = **€122.40**.
- Projection window: 12 months from today.

## Case A — nothing unusual

Daily walk: Sep 1 +30.60 → 153.00; Oct 1 +30.60 → **183.60**; Oct 15 −183.60
→ **0.00**; Nov–Mar +30.60×5 → 153.00; Apr 1 → 183.60; Apr 15 −183.60 → 0.00;
May–Aug fills → 122.40 at window end.

- October bucket `out` = **€183.60** (once).
- Projected low = **€0.00**; `spare` = low − floor = **€0.00**.
- `fillSource` = `scheduled`, `monthlyFill` = **€30.60**.

## Case B — October bill paid early by hand

Add: 2026-10-10 hand expense €183.60 from the envelope; the matcher offers the
link (exact amount, 5 days ≤ 10, mutually unique) and the user accepts.

- The occurrence is `settled`; the projection emits **no** pending Oct 15
  event. October out = **€183.60** total, spare unchanged **€0.00**.
- Never −367.20, never −183.60.

## Case C — three unrelated purchases; the bill stays due

Instead of B, add three hand expenses from the envelope: 2026-10-05 €60.00,
2026-10-06 €70.00, 2026-10-07 €60.00. None matches €183.60 within a cent, so
**no settling is offered or applied** — pooling 60+70+60 to cancel the bill is
exactly the v1 #117 defect.

Daily walk from 183.60 on Oct 1: −60 → 123.60, −70 → 53.60, −60 → **−6.40**,
Oct 15 −183.60 → **−190.00**. Fills then add 30.60/month and each later bill
removes exactly its six accumulated fills, so the walk climbs to −6.40 before
every bill and returns to −190.00 after it:

- Projected low = **−€190.00**; `spare` = **−€190.00**.
- The October occurrence remains `pending` and is still forecast.

This is the product philosophy of §4.3 pinned as arithmetic: the false
positive (a hole shown too large, recoverable by looking) is chosen over the
false negative (a real hole hidden). The snapshot must show the bill still due
**and** the overspend, simultaneously.
