// @vitest-environment jsdom
// Tweaks: the accent swatches carry their colour's name, and in Top
// navigation the button that opens Tweaks (the only way back to the side
// rail) is labelled, not a bare icon.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/app.js', () => ({
  state: { meta: null, budgetFolder: null, currentPage: null },
  getPrefs: () => ({ uiMode: 'full', nav: 'top', density: 'comfy', accent: 'sky' }),
  savePrefs: vi.fn(),
  navigate: vi.fn(),
}));

import { renderTweaks } from '../js/ui/tweaks.js';
import { savePrefs } from '../js/app.js';
import { buildShell, applyPrefs } from '../js/ui/shell.js';
import { t } from '../js/ui/i18n.js';

beforeEach(() => {
  document.body.replaceChildren();
  for (const id of ['rail', 'topnav', 'statusbar']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.append(el);
  }
});

describe('tweaks labels', () => {
  it('each accent swatch is a button named after its colour, the current one pressed', () => {
    const host = document.createElement('div');
    renderTweaks(host);
    const sw = [...host.querySelectorAll('.swatch')];
    expect(sw.map(s => s.getAttribute('aria-label'))).toEqual([
      t('tweaks.accentMint'), t('tweaks.accentPeach'), t('tweaks.accentSky'), t('tweaks.accentLilac'),
    ]);
    expect(sw.every(s => s.tagName === 'BUTTON' && s.title)).toBe(true);
    expect(sw.map(s => s.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
  });

  it('the top bar\'s Tweaks button shows its name and says it leads back to the side rail', () => {
    buildShell({ onNavigate: () => {}, onUnallocatedClick: () => {}, onTweaksToggle: () => {} });
    const btn = document.getElementById('topnav-tweaks');
    expect(btn.textContent).toContain(t('nav.tweaks'));
    expect(btn.getAttribute('aria-label')).toBe(t('tweaks.topHint'));
    expect(t('tweaks.topHint')).toMatch(/side rail/);
  });
});


describe('status bar controls', () => {
  it('offers one global lens control and a keyboard-activatable Unallocated button', () => {
    const bar = document.getElementById('statusbar');
    const unallocated = document.createElement('button');
    unallocated.id = 'status-unallocated';
    const budget = document.createElement('button');
    budget.id = 'status-path';
    bar.append(unallocated, budget);
    const onUnallocatedClick = vi.fn();
    const onBudgetClick = vi.fn();
    const onNewTransaction = vi.fn();
    const onChange = vi.fn();
    buildShell({ onNavigate: vi.fn(), onNewTransaction, onBudgetClick, onUnallocatedClick, onTweaksToggle: vi.fn(),
      lens: { read: () => ({ lens: 'booked', horizon: '3m' }), onChange } });
    expect(document.querySelectorAll('.lens-ctl')).toHaveLength(1);
    expect(bar.querySelector('.lens-ctl')).not.toBeNull();
    expect(bar.querySelector('#status-ask-ai')).not.toBeNull();
    expect(document.querySelector('#rail .lens-ctl, #rail-unalloc, #topnav-unalloc')).toBeNull();
    bar.querySelector('#status-new-transaction').click();
    expect(onNewTransaction).toHaveBeenCalledOnce();
    budget.click();
    expect(onBudgetClick).toHaveBeenCalledOnce();
    unallocated.click();
    expect(onUnallocatedClick).toHaveBeenCalledOnce();
    bar.querySelector('[data-lens="forecast"]').click();
    expect(onChange).toHaveBeenCalledWith({ lens: 'forecast' });
  });

  it('saves the bar position through the existing preference store', () => {
    const root = document.createElement('div'); root.id = 'app-root'; document.body.append(root);
    const host = document.createElement('div');
    renderTweaks(host);
    const row = [...host.querySelectorAll('.tweak-row')].find(el => el.querySelector('.label').textContent === t('tweaks.statusbar'));
    const [top, bottom] = row.querySelectorAll('button');
    expect(bottom.getAttribute('aria-pressed')).toBe('true');
    top.click();
    expect(savePrefs).toHaveBeenCalledWith({ statusbarPosition: 'top' });
    expect(top.getAttribute('aria-pressed')).toBe('true');
    expect(bottom.getAttribute('aria-pressed')).toBe('false');
    applyPrefs({ statusbarPosition: 'top' });
    expect(document.documentElement.dataset.statusbarPosition).toBe('top');
    applyPrefs({ statusbarPosition: 'unknown' });
    expect(document.documentElement.dataset.statusbarPosition).toBe('bottom');
  });
});
