# Fictional household example

This is an entirely invented euro household budget for learning Bunvelope.
It is not an anonymised copy of a real household ledger. Names, amounts,
transactions, notes, holdings, assets and identifiers are synthetic.

Two adults have combined monthly take-home pay of €4,000. They own an
invented home with a mortgage, maintain cash reserves, pay a credit card in
full and make regular investments. The snapshot includes opening reserves,
twelve complete months and a partially completed current month. Some recent
payments are booked but not yet cleared.

## What to explore

- **Overview and Reports:** a full year of spending, seasonal bills, a holiday
  and irregular repairs, with actual spending differing from the plan.
- **Accounts:** current and savings accounts, cash, a credit card, a home,
  mortgage and tracked investment portfolio. Card repayments move money
  between accounts; purchases already consumed their spending envelopes.
- **Envelopes and Plan:** everyday spending, annual insurance and vehicle
  charges, holiday savings, a health reserve and an emergency goal. The
  dynamic template funds the plan's monthly averages. A separate template
  assigns €350 per month to the emergency fund. Cash transfers to savings do
  not count as a second expense or a second allocation.
- **Transactions:** split purchases, monthly fills, principal/interest/fee
  mortgage entries, and a repair covered by an envelope transfer.
- **Investments:** purchases, a distribution, a small sale and invented market
  valuations. `DEMO-GLOBAL` and `DEMO-BOND` are fictional, untradeable symbols.
  Their prices and growth assumptions are illustrative, not live market data
  or investment recommendations. Portfolio book value matches the snapshot's
  holding valuation.
- **Stress:** loss of income and discretionary spending cuts. The ordinary
  plan is affordable, while the most severe scenario consumes cash reserves.
- **Comparison:** no imported financial-history snapshots or change logs are
  supplied. Bunvelope begins capturing financial history when you edit the
  example or initialise the comparison view.

The snapshot is dated 8 October 2026. Guest mode shifts its dates and seasonal
calendars together to the current month; the scheduler then posts anything
newly due. Consequently the exact figures can differ with the date you open
it. Loading the folder directly preserves the original dates.

## Maintenance and privacy

Run `node scripts/generate-example-budget.mjs` from the repository root to
rebuild the JSON. The generator reads no source budget, external prices or
personal files. Its public constants are the complete provenance of the
example. Do not replace those constants with copied private records, even if
names or amounts have been changed.

Metadata is constructed from an explicit list. Personal notes, aliases,
reconciliation details, hidden payees, import settings, writer identifiers,
change logs and financial-history snapshots are never carried over.

`tests/example-budget.test.js` checks reproducibility, accounting invariants,
mortgage splits, portfolio reconciliation, stress behaviour and scheduler
idempotence after date shifts. The static browser tests also exercise loading
and editing the example.
