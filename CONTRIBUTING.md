# Contributing

Thanks for taking a look. Bunvelope is a personal project, so replies can take
a while, but bug reports, questions and focused pull requests are welcome.

## Before you open a pull request

```bash
npm install
npm run lint       # ESLint, including the project's own money and storage rules
npm run typecheck  # tsc --checkJs over js/engine/** and js/utils.js
npm test           # the Vitest suite
```

All three must pass. If you touch dates, also run `npm run test:tz` (the suite
in four timezones). If you touch storage, sign-in or the setup wizard, run the
Playwright suite: `npx playwright install chromium`, then
`npx playwright test --project=static` (no database needed).

For a UI change, add a screenshot to the pull request.

## Ground rules the linter enforces

- **No page computes money.** Pages, UI modules and the AI read figures from
  core queries in `js/core/`; a new figure is a new query.
- **Only a session writes.** Changes go through commands
  (`session.dispatch(...)`), never by saving a collection directly.
- **The engine reads no clock.** Every engine function that needs "now" takes
  it as a parameter.
- **No `innerHTML` with interpolated values** unless every value is wrapped in
  `escHtml()`; prefer DOM methods.
- **Never read `tx.amount` directly** for a display or balance; use
  `txAbsAmount(tx)` or `txAccountDelta(tx, accountId)`.
- **Vanilla JS only** on the client: no libraries or frameworks.
- **Every user-visible string** goes into all three locales (`en`, `fi`, `nl`);
  `tests/i18n-parity.test.js` checks this.

## How changes reach this repository

Day-to-day development happens in a separate working repository, and this
public repository receives regular snapshot releases from it. A merged pull
request here is carried over into the working repository, so it can arrive in
the next snapshot as part of a squashed release commit.
