# Product terminology

Use sentence case for actions, dialog titles and page headings. Keep proper names intact. The planning destination is **Budget plan** (Finnish **Budjettisuunnitelma**, Dutch **Budgetplan**). Inflect it naturally in Finnish and use normal sentence casing in Dutch prose. A budget itself is the user's complete financial dataset, not just this destination.

| Concept | English | Finnish | Dutch |
| --- | --- | --- | --- |
| Planning destination | Budget plan | Budjettisuunnitelma | Budgetplan |
| Planned income/expense row | Budget item | Budjettirivi | Budgetregel |
| Create a plan row | Add budget item | Lisää budjettirivi | Budgetregel toevoegen |
| Create an account | New account | Uusi tili | Nieuwe rekening |
| Review month-end projection | Projected month-end balance | Ennustettu kuun lopun saldo | Verwacht saldo op maandeinde |
| Review funding requirement | Required reserve | Tarvittava varaus | Benodigde reserve |

A leading plus is an optional visual creation cue; it does not change the action's wording. Keep the entry button, editor title and empty-state instruction consistent. Existing New envelope, New transaction and New template actions already follow sentence case.

## Financial distinctions

- **Projected month-end balance** is Review's existing projected envelope balance at the end of the selected month. It is not a current account balance.
- **Required reserve** names Review's existing required-balance result. Keep the column legend explaining the monthly funding and annual plan, and the emergency-fund explanation for that envelope's different requirement.
- **Surplus / gap** in Review compares its projected month-end balance with its required reserve. **Projected spare / gap** in Overview is the separate rolling 12-month forecast. Do not rename either as the other.
- **Today, Booked and Forecast** select a balance view. Budget is not a synonym for Booked. **Plan** in the Net worth source selector and Flow's Plan/Actual comparison names a calculation source/view, rather than a link to the Budget plan destination.
- **Actual spending**, remaining planned spending and deposits remain separate measures; this terminology change does not alter their queries or horizons.

## Caller inventory

All copy lives in `js/ui/i18n.js` and its `fi.js` / `nl.js` dictionaries. Preserve key identifiers so callers and stored routes remain stable.

| Surface | Keys / consumers |
| --- | --- |
| Sidebar and planning workspace | `nav.budget`, `workspace.plan`; `ui/shell.js`, shared planning navigation |
| Budget plan heading and editor | `budgetPlan.title`, `addItem`, `emptyNoItems`, `addTitle`, `editTitle`; `pages/budget-plan.js`, `budget-plan-editor.js` |
| Account creation | `accounts.newBtn` and existing `accounts.newTitle`; Accounts and account editor |
| Overview, envelope and Net worth links | `dashboard.openBudgetPlan`, `dashboard.itemsAttentionShow`, `envelopes.viewInBudgetPlan`, `netWorth.openPlan` |
| Recurring costs and discovery | `recurring.manage`, `intro`, `empty`, `startHelp`, `sort_plan`, `planEnd`; `discovery.unsupportedCadence`, `confirmHelp` |
| Flow empty-state link | `flow.openPlan`, `flow.emptyPlanBody` |
| Onboarding guidance | `setup.incomeBody`, `setup.incomeNoAccount`, `gettingStarted.steps.plan.action` |
| Review tables, summary cards and legend | `review.colProjectedEnd`, `review.colMinReq`, `review.legend.surplus`, `review.legend.consolidate`; `pages/review.js` |
| Emergency-fund help | `settings.emergency.hint`; Settings |

Review keeps expandable column definitions. Its full-detail table has a scoped horizontal scroller inside the disclosure, with wrapping headers; table headers remain in normal flow inside that scroller. Check long translations in both the summary cards and expanded full monthly detail, as well as planning links and editor titles.
