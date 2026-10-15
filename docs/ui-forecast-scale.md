# Forecast scale

Net worth's 24-month forecast and long-term projection expose **Fit changes** and **Start at zero** as native pressed buttons in a labelled group. Fit changes is the initial line-chart view. The visible caption identifies the scale and each visible forecast series' start, end and absolute change over the displayed dates. Translations exist in English, Finnish and Dutch.

`scaleControl: true` opts a line chart into this behavior. The shared model fits visible series, visible low/high uncertainty bounds and reference lines over the current zoom window. Hidden outliers do not distort the scale. Existing `niceFitRange` padding handles flat, negative, crossing-zero and all-zero data. Fitting can still include zero when the data warrants it.

Stacked views and bars stay anchored at zero. When stacked, the scale buttons are hidden and the caption explicitly reports Start at zero; switching back restores the chosen line scale. Other charts retain their existing unzoomed/zoomed defaults.

The selection is stored with existing per-budget chart state and survives remounts. Invalid or missing saved values fall back to Fit changes for opted-in charts. Native buttons support Tab, Enter and Space, and shared chart updates restore focus. Table and CSV values are independent of this presentation setting; query results and financial data are untouched.

Verification covers flat/zero/negative/outlier ranges, hidden series, uncertainty, zero-based bar/stack behavior, persisted selection and unchanged table/CSV output. The browser journey switches both forecasts by keyboard, checks focus and table equality, verifies mobile control fit, and confirms the stacked caption.

## Saved simulations

The Simulation selector offers **Actual budget** and named configurations. Actual budget uses the live plan and account interest settings, clearing any legacy Net worth growth/monthly overrides for the query only. Editing it starts an unsaved simulation; saving asks for a name. New starts from Actual budget, Duplicate copies the current assumptions (including valid unsaved edits), and Rename/Delete manage saved configurations. Changing configurations asks before discarding unsaved edits.

Save and Save all write only the selected simulation. Account settings and the budget plan are unchanged. Reset/Reset all discard unsaved changes. **Use budget & account settings** clears the simulation's explicit assumptions and restores Plan with no What if selection; Save all persists that choice. Empty assumptions continue to follow live budget/account changes, rather than freezing today's calculated amounts.

Configurations are budget-scoped UI metadata in `meta.netWorthSimulations`: id, name, account assumptions, contribution source and selected What if id. The selected configuration is a per-budget browser preference. A What if selection references the shared scenario; editing that scenario affects configurations using it. Existing account projection overrides appear as **Previous projection** until the configuration list is first saved, so earlier assumptions remain available. An explicitly empty list prevents deleted legacy configurations from reappearing.

The account table groups by type with collapsible, tinted headers. Per-field Save/Reset icons have accessible names and tooltips; unchanged saves are disabled. Bulk actions sit beside the scale caption. Drafts survive page navigation in the same budget and participate in the unsaved-work guard; failed writes retain them.
