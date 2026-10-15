# Financial amount typography

`moneyEl(value, { role, signed })` uses the canonical `fmt` formatter. Named roles keep the currency, sign, integer and decimals together at full size and contrast, with the UI font and tabular numerals. Missing values remain an em dash. Locale grouping, decimal separators and currency placement come from the existing formatter; role selection never changes a financial value.

| Role | Intended use | Default size |
| --- | --- | --- |
| `hero` | The primary actionable headline, currently Overview's unallocated balance | 56px maximum |
| `summary` | Comparable totals and card balances | 28px maximum |
| `table` | Compact rows, lists and financial tables | 14px |
| `inline` | An amount within surrounding prose | Inherits the surrounding size |

Wrap hero/summary values in `.money-metric`. This establishes an inline-size container; the formatted character count lets unusually long values shrink to fit, down to 14px, without abbreviating, clipping or hiding the sign. Ordinary summary amounts share the same maximum size and weight across pages. Tables retain their horizontal scrollers when their content needs more space.

`amountText(formattedText, role)` applies the same treatment to already formatted values and comparable non-currency metrics, such as percentages and age-of-money days. Do not use it to add financial arithmetic to a page. Static formatted table text can use `.money-amount.money-table`.

The audited Overview, Detailed insights, Accounts, Investments (including Performance and Tax), Recurring costs and Reports now use these roles for their financial summaries. Display typography remains for headings. The existing `size` option remains available for other callers; it is not a new pattern to copy into these views.

## Account-card alignment

Account grids use four shared subgrid rows: name/header, balance, supporting details, and actions. Long names wrap fully, and the longest header in each visual row determines where every balance starts. Upcoming amounts, interest, loan details, portfolio values and notes occupy the supporting row, so they cannot push individual balances away from their peers. Cards and actions keep their existing behavior.

Styles live in `css/money.css`, loaded after page styles and before dark-theme overrides. Formatting tests cover signed/negative/zero/missing values, Finnish/Dutch/US number formats and both currency placements. The browser matrix checks all six views at 1440 and 1024 pixels in light and dark themes, long-name card alignment, long negative amounts, and unchanged financial records.
