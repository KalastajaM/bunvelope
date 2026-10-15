// @vitest-environment jsdom
// The Enable encryption dialog says what enabling does beyond this budget
// before the passphrase is typed.
import { describe, it, expect, beforeEach } from 'vitest';
import { promptSetup } from '../js/ui/passphrase-prompt.js';
import { t } from '../js/ui/i18n.js';

beforeEach(() => {
  document.body.replaceChildren();
  for (const id of ['app-root', 'sheet-host', 'toast-host']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.append(el);
  }
});

describe('promptSetup', () => {
  it('states that one passphrase converts every budget, is asked at each sign-in, and the CLI refuses encrypted budgets', () => {
    promptSetup();
    const facts = [...document.querySelectorAll('.security-setup-facts li')].map(li => li.textContent);
    expect(facts).toEqual([
      t('security.setup.factAllBudgets'),
      t('security.setup.factEachSignIn'),
      t('security.setup.factCli'),
    ]);
    expect(facts[0]).toMatch(/every budget/);
    expect(facts[1]).toMatch(/each time you sign in/);
    expect(facts[2]).toMatch(/CLI/);
    expect(document.body.textContent).toContain(t('security.setup.warning'));
  });
});
