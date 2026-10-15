# Budgeting guides and quick tour

Settings → Help contains five chapters under **How Bunvelope works**, followed by the short concept references. The chapters follow one illustrative household through accounts, envelope allocation, planning, spending/review and stress. They are read-only and available in English, Finnish and Dutch, including simple mode.

Account and envelope help, Unallocated/Fills help, and the Budget plan, Templates, Review and Stress page explanations link to the relevant chapter. The contents card matches Quick reference's 560px width and uses aligned, clickable chapter rows. Chapters can be selected with the app's standard labelled dropdown or read with Previous/Next. Dropdown changes retain keyboard focus; Previous/Next moves focus to the new heading. The existing sheet supplies Escape, focus containment and return to the opener.

The quick tour follows the first budgeting cycle in nine steps, with a tenth step explaining Tweaks in simple mode. Its final step links to the guides. AI availability does not change the tour; advanced screens are optional learning topics rather than mandatory stops.

## Shared quick reference

Quick reference covers seven core topics: accounts and envelopes; Unallocated and fills; Today, Booked and Forecast; envelope balance, reserve and spare; transactions and transfers; reconciliation; emergency reserve and stress runway. Each short summary opens the full explanation and links to the relevant guide chapter.

The same `help.*` entries power contextual `?` buttons on Accounts and Envelopes, the balance-view switcher, envelope spare figures in both grid and list views, the Fill dialog, Review, Transactions, reconciliation, Stress and emergency settings. Edit the shared locale entries to update both entry points. Specialist explanations remain alongside their features, such as investment fees and the Age of Money detail view.

The browser regression compares Quick reference with the contextual sheets, checks nested guide navigation and keyboard focus return, verifies translated balance-control labels, and confirms that reading help leaves budget collections unchanged. Desktop and 390px phone screenshots cover English, Finnish and Dutch, including dark mode, without horizontal overflow or uncaught page errors.

Screenshots: [Seven-topic reference](images/budgeting-guides/reference-desktop.png), [contextual envelope help in Dutch](images/budgeting-guides/figures-mobile-nl.png).

## Content ownership

`js/ui/budget-guides.js` owns the reader and chapter order; `guides.*` in the three locale dictionaries owns the content. Keep the examples aligned across locales and label them as examples, never live budget figures. The same locale dictionaries own the short tour and contextual help.

Guide styles live in the existing `css/app.css` rather than requiring an additional stylesheet link in the HTML shell.

The chapter dropdown uses the same `.field` control as Settings. Browser verification checks its background, border, radius, height and font against the existing country selector, plus desktop card alignment, mobile overflow and selection/focus behavior.

Check explanations against these calculation owners when changing behavior:

- `js/engine/balances.js`: budget-account scope, Unallocated and crisis-cash eligibility.
- `js/engine/tx-amounts.js`: expenses, fills, account and envelope transfers.
- `js/engine/lens.js`: Today, Booked and Forecast.
- `js/engine/scheduling.js` and `js/core/commands/allocation-fill.js`: scheduled occurrences and template fills.
- `js/engine/monthly-review.js`: rollover, required reserves and the emergency requirement.
- `js/core/queries/stress-runway.js`: cash after buffers, scenario income/costs and average runway.

`tests/budget-guides.test.js` covers chapter navigation and contextual entry. Settings and onboarding tests cover discoverability and tour order; the guest browser test covers keyboard handoff, the simple-mode tour and reading without changing budget collections.

## Verification

The implementation passed lint, engine type checking and the full Vitest suite (6,991 passed, 92 skipped). Both focused guest browser tests passed in Chromium. Desktop and 390px phone checks covered the guide index, chapter reader, contextual entry, the nine-step tour and its keyboard handoff, with no uncaught page errors or horizontal overflow in English, Finnish or Dutch guides.

Screenshots: [Help](images/budgeting-guides/help-desktop.png), [reader](images/budgeting-guides/guide-desktop.png), [Dutch on a phone](images/budgeting-guides/stress-mobile-nl.png), [tour handoff](images/budgeting-guides/tour-finish-desktop.png).
