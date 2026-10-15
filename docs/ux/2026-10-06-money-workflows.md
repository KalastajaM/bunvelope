# Accounts, Envelopes and Templates workflow pass

The owner requested a consistency pass across these pages and their related dialogs after preferring fixed header actions in the Budget editor.

## Findings and changes

- **Accounts:** card and list actions use compact icons with localized tooltips and accessible names for Edit, Reconcile or Update value. The page distinguishes accounts from spending availability, retains its existing account-type groups and filter, and uses the operational money typography. The editor explains opening balance versus current-balance correction. Optional tracking/budget behavior is grouped under Advanced settings; archive/delete controls use the shared action header.
- **Envelopes:** the page explains selected-view balance versus projected spare/gap. Search and category can be combined with Projected funding gap or Negative balance filters. These use the existing query answers and intentionally differ: a positive balance can have a projected shortfall. Card/list actions use icons with Edit and Funding review tooltips and accessible names. Savings goals and advanced policies have separate editor sections.
- **Templates:** search combines with Scheduled/Manual only filtering; manual templates show their actual unallocated funding basis rather than an inactive scheduled source. Long dynamic assignment lists now use the form's single scroll area. Both editor types and the command-based application preview keep their primary actions visible.
- **Dialogs:** account/envelope/template editors, fill, transaction entry/editing (including transfers), reconciliation and valuation use fixed header actions above separately scrolling content. Action placement follows the newly integrated shared dialog layout. Existing calculations, commands, confirmation prompts and dirty guards are retained.

## Implementation and validation

`openSheet` uses the shared header/body layout from development. Submit buttons outside a form use native form association, preserving browser validation and existing submit handlers. Invalid fields in collapsed sections are exposed. Dialog accessible names contain the title, not action labels.

Regression tests exercise header submission/validation, the difference between negative envelope balances and projected gaps, and combined template filters. Existing financial workflow tests still exercise the real browser session and write boundary. Chromium checks with the authorized copied budget cover desktop and 390px phone layouts and stationary header actions while eight dialogs scroll. The static Playwright journeys cover guest and local-folder writes. Private budget figures and screenshots are not committed.
