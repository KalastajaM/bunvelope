// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { listColumns, listColumnRow } from '../js/ui/list-columns.js';
import { prefs, resetState, mountHosts } from './_fakes/pageApp.js';

beforeEach(() => { resetState(); mountHosts(); });

it.each([
  ['accounts', ['name', 'balance', 'details', 'actions']],
  ['envelopes', ['name', 'balance', 'progress', 'actions']],
  ['plan', ['item', 'schedule', 'settings', 'annual']],
])('automatically sizes %s columns and ignores old manual preferences', (kind, keys) => {
  const host = document.createElement('div');
  const baseline = document.createElement('div');
  listColumns(baseline, kind);
  prefs[`${kind}ColumnWidths`] = Object.fromEntries(keys.map(key => [key, 800]));
  prefs[`${kind}ColumnOrder`] = [...keys].reverse();
  listColumns(host, kind);
  expect(host.style.getPropertyValue('--list-columns')).toBe(baseline.style.getPropertyValue('--list-columns'));
  expect(host.style.getPropertyValue('--list-columns')).toContain('minmax(');
  expect([...host.querySelectorAll('.list-column-label')].map(el => el.dataset.listColumn)).toEqual(keys);
  expect(host.querySelector('button, [role="separator"]')).toBeNull();
  const row = document.createElement('div');
  for (const text of keys) {
    const cell = document.createElement('span'); cell.textContent = text; row.append(cell);
  }
  listColumnRow(row, kind);
  expect([...row.children].map(el => el.dataset.listColumn)).toEqual(keys);
  expect([...row.children].map(el => el.textContent)).toEqual(keys);
});

it('does not add headings to card or empty views', () => {
  const host = document.createElement('div');
  listColumns(host, 'accounts', false);
  expect(host.children).toHaveLength(0);
  expect(host.classList.contains('column-layout')).toBe(false);
});

it('keeps a separate sticky heading aligned through scrolling and clears it for cards', () => {
  const host = document.createElement('div');
  const heading = document.createElement('div');
  document.body.append(heading, host);
  listColumns(host, 'envelopes', true, heading);
  expect(heading.querySelector('.list-column-header')).not.toBeNull();
  expect(host.querySelector('.list-column-header')).toBeNull();
  expect(heading.style.getPropertyValue('--list-columns')).toBe(host.style.getPropertyValue('--list-columns'));
  host.scrollLeft = 100;
  host.dispatchEvent(new Event('scroll'));
  expect(heading.scrollLeft).toBe(100);
  heading.scrollLeft = 50;
  heading.dispatchEvent(new Event('scroll'));
  expect(host.scrollLeft).toBe(50);
  listColumns(host, 'envelopes', false, heading);
  expect(heading.hidden).toBe(true);
  expect(heading.children).toHaveLength(0);
  expect(host.onscroll).toBeNull();
  expect(heading.onscroll).toBeNull();
});
