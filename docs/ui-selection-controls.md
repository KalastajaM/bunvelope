# Selection controls

Choose the pattern by what changes when a user activates it.

| Purpose | Pattern | Semantics and interaction | Existing examples |
| --- | --- | --- | --- |
| Switch between named content sections | Shared `contentTabs` | `tablist`, `tab`, `tabpanel`; selected tab has `aria-selected=true` and the only tab stop in the strip. Left/Right wraps; Home/End selects first/last enabled tab. Tab enters the panel. | Settings, Investments |
| Choose one view or representation of the same content | Inset segmented buttons (`.seg`) | Labelled button group; `aria-pressed` exposes the active choice. Each button retains normal button keyboard behavior. | Money flow, Overview envelope views |
| Narrow a result set | Filter buttons/chips | Buttons with `aria-pressed` for toggle filters; removable chips use a named remove button. Counts describe matching results. | Review (`.workspace-nav`), Transactions filters |

Content tabs use a shared 44px minimum target, horizontal scrolling, underline and font weight for selection, and an inset keyboard-focus outline. Selection does not use the filled primary-action style. Disabled tabs are native disabled buttons and are skipped by arrow navigation. Focused tabs/panels have scroll clearance for sticky headers. Segmented controls and filters retain their existing selection styles and button semantics; they are not ARIA tabs.

## Using the content-tab component

`js/ui/content-tabs.js` exports `contentTabs(entries, initialKey, { label, onSelect })`. Each entry is `[key, localizedLabel, panelElement, { disabled }]`; the fourth element is optional. Supply a localized label for the tablist. Mount the returned strip and the panel elements, then call `strip.restoreSelectedTab()` to reveal a selected tab on a narrow strip. Pass `{ focus: true }` only when replacing a strip that already owned keyboard focus; normal page entry must not steal focus.

The component assigns unique tab/panel IDs, reciprocal ARIA links, panel visibility and roving tabindex. An invalid or disabled initial key falls back to the first enabled tab. Empty panels remain reachable through Tab. Initial construction does not call `onSelect`; a changed selection calls it once. Repeated activation of the selected tab leaves its content intact.

Settings keeps its strip mounted and lazily replaces panel content on selection. Each render uses a fresh content node so late asynchronous work from the previous section cannot populate the new section. Its existing deep links and conditional AI availability remain intact. Investments keeps its prebuilt panels and remembers the selected section through refreshes.

Keep panel switching synchronous; slow data may load inside an already selected panel. If a future section must wait before becoming available, use an explicit manual-activation tab design rather than letting arrow keys block on the request.
