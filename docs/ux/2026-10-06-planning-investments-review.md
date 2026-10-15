# UX review: planning, templates and investments

Reviewed 6 October 2026. Scope: Budget, Review, Stress, Templates and Investments. This is a proposal, not an implemented redesign.

## Evidence and limits

Walked the current app in Chromium with an isolated guest import of the owner's authorized budget copy. Inspected desktop (1440px) and phone (390px), the budget-item editor, dynamic-template editor, extra-versus-early template choice and final extra-fill preview, Stress scenario expansion, and Review's funding action. No financial edits were submitted. Inspected source to distinguish missing UI from functionality already present. Private screenshots and exported figures stay outside this repository.

This is an expert walkthrough, not measured user testing. Competitor comparisons use official public product documentation, not authenticated hands-on tests or a claim that any one product is universally best.

## Findings and concrete changes

| Priority | Area | Observed friction | Proposed change |
|---|---|---|---|
| P1 | Review balance basis | The view chip says Today, but the current-month unallocated badge explicitly queries Booked. The supplied copy produces materially different Today and Booked pools. | Label the badge Booked explicitly and show Today alongside it, or consistently use Today if that is the intended funding basis. Do not silently alter allocation semantics. |
| P1 | Template application | The final Extra fill sheet shows computed assignment lines and an account field clearly marked tagging-only, but no resulting source/pool balances. The preceding extra-versus-run-early choice correctly prevents unintended double funding. | Preserve that choice, then show execution date, actual funding source, total money moved, source/Today/Booked balances before and after, and changed envelope balances. Preview the actual command for both modes, including Set lines and skipped occurrences. Keep tagging account secondary. |
| P2 | Budget hierarchy | Annual totals and six filter controls lead; stress-category chips compete with amounts and schedules on every row. An existing Not on track filter is available but buried. | Keep search and category prominent; offer task filters All / Needs funding / Upcoming / Disabled. Put other filters in an expandable panel. Default row: item, next due, period amount, funding status. Preserve configurable columns and stress settings as optional detail. |
| P2 | Budget editor | Scheduling, budget inclusion, funding classification, stress cuts and a twelve-month grid share one long editor. | Group Basics, Schedule, Monthly amounts and Advanced. Keep essential fields visible and provide a persistent summary of the next occurrence and whether Save can post an already-due transaction. Advanced controls remain accessible. |
| P2 | Review hierarchy | The full seven-column analytical table leads. Paired figures and labels such as Deposit (D) and Min req require consulting the existing legend. Funding uses an icon action beside the envelope. | Lead with a month summary and Needs funding / Surplus / All. Default rows show envelope, expected month-end balance, required reserve, gap and a named Review funding action. Preserve the full current table in Detailed analysis and the legend. Keep past months read-only and the ended-month close rule. |
| P2 | Stress interpretation | A–E share labels with item priority categories; severity and model assumptions need explanation. A finite multi-year runway and surplus scenarios all display full green bars in the supplied copy. | Label severity explicitly (A most severe through E mildest), summarize income loss, expense reduction, usable cash and reserve exclusions, then compare net/month and runway. Present No cash burn under these assumptions rather than suggesting guaranteed infinite safety. Keep annual totals available. |
| P2 | Stress editing | Expanded cut sliders persist via the live item-update path on change. Reset is available, but the boundary between experimenting and editing saved assumptions is easy to miss. | Show Editing saved scenario assumptions and save state clearly. If a sandbox is added later, make it a separate Preview / Apply flow with deliberate persistence; do not imply existing edits are temporary. |
| P2 | Templates overview/editor | Cards already show next run, line count, total and Edit/Fill now. Funding source is absent from the card; in the long dynamic editor, schedule/source controls follow all assignment rows. Add/Set and annual-average percentages require interpretation. | Lead with when, from where and expected next-run effect. Put schedule/source summary before assignments. Explain Add as add an amount and Set as bring the balance to a target; retain the distinction that dynamic percentages use the annual monthly average, not necessarily this calendar month's expenses. |
| P2 | Investments hierarchy and trust | Allocation and Net invested charts precede holdings. Net invested is a contribution measure, not portfolio return. Price dates/staleness exist in rows; zero recorded cost can produce a large displayed gain. Tax analysis is appended to the same long page. | Make Holdings the default, with Overview / Holdings / Activity / Tax navigation. Lead with valuation date coverage and items needing price/cost review. Identify zero recorded basis without assuming it is missing or invalid. Name Net contributions explicitly. Keep unrealized P/L separate from a true period-return view; implementing the latter requires a separately specified data model and calculation. |
| P2 | Phone comparisons | Pages fit the viewport, but Review and Stress intentionally use horizontal table scrolling. On Stress, the initially visible columns omit the most useful net/runway result. | Provide a compact summary/card mode on phones with the decision metric first and expandable detail. Retain horizontal comparison tables for users who need every column. Investments should bring holdings and data-quality signals before a tall chart stack. |

Source anchors: `js/pages/review.js` (view chip, current-month pool query, table and consolidate action); `js/pages/templates.js` (card, schedule editor, openApplyToPoolSheet); `js/pages/budget-plan.js` and `budget-plan-editor.js`; `js/pages/stress.js` (scenario row, runway and slider change handler); `js/core/queries/stress-runway.js` (model assumptions); `js/pages/investments.js` (charts, price dates, cost and P/L) and `investments-tax.js`.

## Proposed page structure

- **Budget:** shared Plan / Monthly review / Stress links → explicit period → summary → task filters → compact item list → item detail/editor.
- **Review:** selected month + explicit balance bases → funding summary → exceptions list with named actions → optional full analysis → close-month action when eligible.
- **Stress:** saved-assumptions notice → baseline and selected-scenario results → visible assumption changes → affected items → comparison table and configuration checks.
- **Templates:** next scheduled runs with source and expected effect → template detail (Schedule / Assignments) → extra versus early choice → command-based before/after preview → explicit confirmation.
- **Investments:** valuation/data-quality summary → Holdings by default → account/security drill-down; contribution history, allocation and tax have dedicated views.

## Useful external patterns

- [YNAB targets](https://support.ynab.com/how-to-use-targets-rk5kkI9ks) distinguishes setting aside another amount from refilling to a target. Borrow the plain-language choice for template Add/Set, not YNAB's financial model. Its [target redesign announcement](https://www.ynab.com/whats-new/noticed-a-change-to-your-progress-bars) explicitly emphasizes configuring behavior without memorizing target types.
- [Actual schedules](https://actualbudget.org/docs/schedules/) emphasizes upcoming activity and distinguishes automatic entry from manual approval. Borrow the visible execution model; Bunvelope already has scheduling and an early-versus-extra distinction.
- [ProjectionLab](https://projectionlab.com/) emphasizes simulation, trade-offs and drilling into projected periods. Borrow visible assumptions and scenario comparison; adding Monte Carlo simulation is not required for this UX work.
- [Monarch investments](https://help.monarch.com/hc/en-us/articles/41855507661076-Investments-in-Monarch) separates holdings from advanced allocation analysis and provides holding drill-down. Its documentation also qualifies performance when purchase history is unavailable. Borrow separation of holdings, contributions and returns, with explicit data limitations. Do not copy its US-oriented pricing assumptions or treat a cost-basis gain as time-weighted return.

## Recommended implementation order

1. Correct Review's basis labeling and add an actual before/after template application preview. These are trust improvements with bounded scope.
2. Prototype Budget + Review together using existing calculations and queries. Validate finding an upcoming bill, identifying a month-end funding gap, and understanding a proposed allocation.
3. Clarify Stress severity, cash assumptions and persistent edits; validate phone comparison before changing its default layout.
4. Reorganize Investments around holdings and valuation confidence. Treat real historical performance as a separate feature, not a cosmetic chart rename.

Acceptance tasks: identify the source of a template run without entering its editor; explain whether running early will run again; distinguish a month-end reserve gap from annual surplus; explain which pool Review shows; identify what a Stress edit saves; distinguish net contributions, unrealized gain and investment return. Validate with actual user sessions before claiming a measured usability improvement.

## Implementation (2026-10-06)

The approved workspace improvements are implemented across all five pages:

- **Budget:** task views for All, Needs funding, Upcoming (30 days), and Disabled; secondary filters in a disclosure; next occurrence dates from the existing `upcoming` query; optional row stress controls; editor sections for basics, scheduling, monthly amounts and advanced settings, with a visible warning about posting due schedules on save.
- **Review:** explicitly labeled Today and Booked pools; funding-gap and surplus cards with named reserve-adjustment actions; full monthly detail remains available, with existing historical and close-period behavior.
- **Stress:** severity labels, usable-cash and reserved-cash context, disclosed assumptions, explicit automatic persistence and saving state, no-cash-burn wording, and phone cards that keep annual net and runway visible. The original annual detail remains available.
- **Templates:** scheduled funding source on cards, schedule/source before assignments in editors, plain-language Add/Set help, and a command-based fill preview showing both pool lenses and every affected Booked envelope balance. Apply waits for a valid preview and refreshes it when its inputs or budget state change. Extra fills and early scheduled fills retain their different funding/occurrence semantics.
- **Investments:** holdings-first views for Holdings, Overview, Activity and Tax, retained view selection after edits, valuation details for stale/missing prices and zero recorded cost basis, and explicit contribution-versus-return wording.

Financial calculations and writes retain the existing core queries and commands. True period investment performance still requires a separate data/model specification; contribution history is not presented as returns. The uploaded budget copy was used in a local guest session for desktop and 390-pixel phone validation. Private budget figures and screenshots are excluded from this repository.

Final checks after integrating development: lint and typecheck pass; Vitest reports 6,622 passed and 87 skipped; all five static Playwright journeys pass. The guest journey now locates the labeled Unallocated card and named Groceries input instead of relying on older text and input order. Planning/editor/preview/reserve and investment-tab workflows were also exercised against the copied budget. Delivered in PR #389.

Owner follow-up: Budget-item Delete/Cancel/Save actions now sit in a fixed header above a separately scrolling form, replacing the overlapping sticky footer. Removed duplicate Budget/Review/Stress page navigation; the sidebar owns navigation. Grouped All/Needs funding/Upcoming/Disabled with search and Category in the same filter panel. Desktop and phone scroll checks confirm the Save button retains its position while the form scrolls to its end.
