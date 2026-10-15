// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { contentTabs } from '../js/ui/content-tabs.js';
beforeEach(() => document.body.replaceChildren());
const mount = (initial = 'a', disabled = false) => {
  const entries = ['a', 'b', 'c'].map(key => [key, key.toUpperCase(), document.createElement('section'), { disabled: disabled && key === 'b' }]);
  const onSelect = vi.fn();
  const nav = contentTabs(entries, initial, { label: 'Sections', onSelect });
  document.body.append(nav, ...entries.map(e => e[2]));
  return { nav, entries, onSelect, tabs: [...nav.children] };
};
const press = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
it('links unique tabs and panels and gives the selected tab one tab stop', () => {
  const { nav, entries, tabs, onSelect } = mount('b');
  expect(nav.getAttribute('role')).toBe('tablist');
  expect(nav.getAttribute('aria-label')).toBe('Sections');
  expect(tabs.map(t => t.tabIndex)).toEqual([-1, 0, -1]);
  for (let i = 0; i < tabs.length; i++) {
    const panel = entries[i][2];
    expect(tabs[i].getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[i].id);
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.hidden).toBe(i !== 1);
    expect(tabs[i].hasAttribute('aria-pressed')).toBe(false);
  }
  const other = mount();
  expect(other.tabs[0].id).not.toBe(tabs[0].id);
  expect(onSelect).not.toHaveBeenCalled();
});
it('wraps arrows, supports Home/End and leaves Tab to normal focus traversal', () => {
  const { tabs, entries, onSelect } = mount();
  tabs[0].focus(); press(tabs[0], 'ArrowLeft');
  expect(document.activeElement).toBe(tabs[2]);
  expect(entries[2][2].hidden).toBe(false);
  press(tabs[2], 'ArrowRight'); expect(document.activeElement).toBe(tabs[0]);
  press(tabs[0], 'End'); expect(document.activeElement).toBe(tabs[2]);
  press(tabs[2], 'Home'); expect(document.activeElement).toBe(tabs[0]);
  expect(press(tabs[0], 'Tab')).toBe(true);
  expect(onSelect.mock.calls.map(c => c[0])).toEqual(['c', 'a', 'c', 'a']);
});
it('skips disabled tabs and falls back from unavailable initial selections', () => {
  const { tabs, entries } = mount('b', true);
  expect(tabs[0].tabIndex).toBe(0);
  press(tabs[0], 'ArrowRight');
  expect(document.activeElement).toBe(tabs[2]);
  tabs[1].click();
  expect(entries[2][2].hidden).toBe(false);
  expect(tabs[1].disabled).toBe(true);
});
it('keeps an empty selected panel focusable and restores focus only on request', () => {
  const { nav, tabs, entries } = mount('c');
  const input = document.createElement('input'); document.body.append(input); input.focus();
  nav.restoreSelectedTab(); expect(document.activeElement).toBe(input);
  nav.restoreSelectedTab({ focus: true }); expect(document.activeElement).toBe(tabs[2]);
  entries[2][2].focus(); expect(document.activeElement).toBe(entries[2][2]);
});
it('handles no available sections without inventing a selected tab', () => {
  const nav = contentTabs([], 'missing', { label: 'Empty' });
  document.body.append(nav);
  expect(nav.querySelector('[aria-selected=true]')).toBeNull();
  expect(() => nav.restoreSelectedTab({ focus: true })).not.toThrow();
});
