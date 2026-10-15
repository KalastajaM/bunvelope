# Golden scenario narratives

Pre-work for the golden-file scenario tests of `../../04-invariants-and-proof.md`
§2.2: the ~15 narratives, written down **before any v2 code exists** so the
expected values are computed by hand from the normative rules in
`../../02-business-rules/`, not read back from the implementation they are
supposed to judge.

**Status: normative pre-work.** At M1 each scenario is encoded as
`{ ledger, config, expected }` and wired to a snapshot runner that captures
**every derived surface at once** — balances, projection, lens rows, monthly
review, reports. The hand-computed values below are the critical assertions;
the full output vector is generated at implementation time and then reviewed
against these numbers before being blessed as the snapshot. A generated value
that contradicts a hand-computed value here means the implementation is wrong
or this file is — and the disagreement is resolved on paper first.

## Conventions

- Currency is EUR. Amounts are written `€100.00` for readability; the encoded
  form is integer cents (`bigint`, R3).
- Dates are ISO `YYYY-MM-DD` (R1). The banking calendar is **FI** unless a
  scenario says otherwise.
- "today" / `asOf` is always stated explicitly (R4); no scenario depends on
  the wall clock.
- Unless stated, envelopes start at zero (no opening balance — postings only),
  rollover policy is `carry`, and `include` is not `false`.

## The scenarios

| # | File | Bug class / rule pinned | Spec |
|---|---|---|---|
| S01 | `01-quarterly-bill-paid-early.md` | A4/A5: counted exactly once across settle-by-hand + materialise + rollover, in a DST month | `01-calendar…` §2–3, `03-planning…` §9 |
| S02 | `02-property-tax-netting.md` | The €183.60 / €122.40 reported shape; no pooled netting | `04-forecast…` §4, §8 |
| S03 | `03-review-seeding.md` | The −€2,550 seeding trap: as-of balances, not booked | `03-planning…` §8.3 |
| S04 | `04-trim-bound.md` | The −€49,200 unit bug: trim bounded by the fill, unit declared (A7) | `04-forecast…` §5.3 |
| S05 | `05-month-end-window-straddle.md` | Bill on the 31st vanishing between windows | `01-calendar…` §2.1 |
| S06 | `06-buffer-stock-not-flow.md` | The €129.53 overfund: buffer is a floor, never annualised | `03-planning…` §3 |
| S07 | `07-deposit-and-required.md` | `calcDepositAndRequired` worked cases | `03-planning…` §4 |
| S08 | `08-zero-income-keeps-template.md` | Zeroing an income must not drop its month's allocation | `01-calendar…` §2.2, §4 |
| S09 | `09-source-funded-template.md` | Source draw: unallocated unmoved, display total not doubled, negative monthlyFill kept | `01-calendar…` §4.2, §6; `04-forecast…` §3 |
| S10 | `10-rollover-catchup.md` | Three closed months, oldest first, dated month-end | `03-planning…` §9 |
| S11 | `11-set-resolution-order-independence.md` | A2/A6: `set` resolved at write; shuffle changes nothing | `02-postings…` §1.1 |
| S12 | `12-oversold-position.md` | Oversell books zero invented profit | `02-postings…` §4.1 |
| S13 | `13-dividend-is-income.md` | The dividend rule on every surface, incl. stress | `03-planning…` §1.1, §12 |
| S14 | `14-goal-pace-abstain.md` | Goals >1y out abstain; `monthlyRequired` rounds up | `03-planning…` §10 |
| S15 | `15-age-of-money-window.md` | One half-open window; starved sample nulls; DST day spans | `04-forecast…` §6 |
| S16 | `16-emergency-credit.md` | Emergency credit reads current balances, clamped listing | `03-planning…` §7 |

## Timezone matrix

Every scenario runs under all four zones of `../../04-invariants-and-proof.md`
§2.5 (`UTC`, `Europe/Helsinki`, `America/Los_Angeles`, `Australia/Lord_Howe`)
with **identical expected values** — the engine's dates are calendar dates, so
any zone-dependent result is a bug by construction. S01 and S15 place events
across a European DST transition on purpose.
