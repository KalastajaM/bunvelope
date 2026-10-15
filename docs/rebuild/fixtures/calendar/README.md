# Golden calendar fixtures

Pre-work for `../../02-business-rules/01-calendar-and-scheduling.md` §1.6 and
`../../04-invariants-and-proof.md` §2.4: one holiday-set fixture per
jurisdiction per year (2025–2027), verified against **authoritative sources**
rather than ported from v1's tables — §1.5 names four suspected v1 errors,
and this research confirmed three of them (US Good Friday/Easter Monday, DE
Maundy Thursday, GB Holy Saturday + missing early-May holiday).

Each `<CC>.json` records the closure-day sets, the sources, a per-year
confidence flag, and country-specific findings. At M1 these become the
expected outputs of `holidaysFor(calendar, year)` once each jurisdiction's
rule file is written in the six-primitive algebra; a fixture entry marked
below par gets re-verified before its data file is blessed.

## Conventions

- Dates are `YYYY-MM-DD`. Ordinary weekends are not listed; **named holidays
  that fall on a weekend are listed** for calendars without substitute-day
  shifting (FI/SE/NO/DK/DE) and flagged in each file's notes.
- GB lists GOV.UK's dates verbatim — there the **substitute day is the
  holiday** (observance `nextWorkingDay`).
- US lists actual Federal Reserve closure days — observance
  `followingMonday`, and a Saturday-falling holiday produces **no** closure
  at all (see the finding below).
- Structurally-always-weekend holidays (Easter Sunday, Whit Sunday, Swedish
  Midsummer Day, Finnish All Saints) are omitted where the banking authority
  omits them; `FI.json`'s notes describe how to treat them when encoding the
  rule files.

## Status

| Calendar | 2025 | 2026 | 2027 |
|---|---|---|---|
| FI | reconstructed | **primary** (Suomen Pankki) | **primary** |
| SE | secondary | secondary — re-verify against a Riksbank/bankers'-association table before encoding | secondary |
| NO | reconstructed | **primary** (Norges Bank) | reconstructed |
| DK | pattern-confirmed | **primary** (Nationalbanken) | **primary** |
| DE | **primary** (rule set from Bundesbank Merkblatt) | **primary** | derived from confirmed rules |
| GB | **primary** (GOV.UK) | **primary** | **primary** |
| US | reconstructed | **primary** (Fed K.8) | **primary** |
| EE | medium (statute via snippet) | medium | medium — re-verify statute directly |
| LV | **primary** (likumi.lv) | **primary** | **primary** |
| LT | medium — legal portals bot-walled; re-verify Art. 123 (esp. Nov 2) | medium | medium |

## Findings for spec review

1. **US observance** (`US.json`) — **applied to the spec 2026-08-27**: the
   Fed does **not** observe Saturday-falling holidays on the preceding
   Friday — Reserve Banks stay open; only Sunday-falling holidays shift to
   Monday. §1.1 now states the asymmetric rule and prescribes
   `followingMonday` for the US calendar.
2. **FI fixture in §1.6** (`FI.json`) — **applied to the spec 2026-08-27**:
   it listed 2026-04-04 (Holy Saturday — not a Finnish holiday; the same
   Easter−1 error §1.5 flags for GB) and omitted Whit Sunday. §1.6 is
   corrected (04-04 dropped, 05-24 added) and now records both corrections
   inline.
3. **DK** (`DK.json`): Store Bededag is genuinely gone (banks did not retain
   it); Danish banks close the Friday **after** Ascension every year; and
   May 1 is not a Danish bank closure day. All three differ from a naive
   Nordic template.
4. **NO** (`NO.json`): Dec 31 is not a Norwegian bank closure day (it is in
   SE and DK). 2027-05-17 has Constitution Day and Whit Monday coinciding —
   a resolver must yield a set, not a duplicate.
5. **LV** (`LV.json`): Latvia has a statutory substitute-day rule (May 4 /
   Nov 18 on a weekend → next working day off; 2025-05-05 is a live
   instance) — a real `nextWorkingDay` observance case in the fixture set,
   alongside GB's Christmas chain. One open conflict (Mother's Day
   classification) is recorded in the file; it never affects working-day
   arithmetic.
