// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { resetState, prefs, savePrefs } from './_fakes/pageApp.js';
import { fitDetails } from '../js/ui/fit-details.js';

let resize, paint, top, card, neighbour, details, leftHeight, sideBySide;
beforeEach(() => {
  resetState();
  vi.stubGlobal('ResizeObserver', class { constructor(fn) { resize = fn; } observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', fn => { paint = fn; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  document.body.innerHTML = '<div><section></section><section><details><summary>Balance</summary><p>Details</p></details></section></div>';
  top = document.body.firstChild; [neighbour, card] = top.children; details = card.querySelector('details');
  leftHeight = 500; sideBySide = true;
  Object.defineProperty(card, 'offsetLeft', { get: () => sideBySide ? 500 : 0 });
  neighbour.getBoundingClientRect = () => ({ height: leftHeight });
  card.getBoundingClientRect = () => ({ height: details.open ? 400 : 240 });
});
afterEach(() => vi.unstubAllGlobals());
it('expands only within the neighbour’s height and collapses when the cards stack', () => {
  fitDetails(top, card, neighbour, details, 'balance'); paint();
  expect(details.open).toBe(true);
  leftHeight = 300; resize(); paint(); expect(details.open).toBe(false);
  leftHeight = 500; resize(); paint(); expect(details.open).toBe(true);
  sideBySide = false; resize(); paint(); expect(details.open).toBe(false);
  expect(savePrefs).not.toHaveBeenCalled();
});
it('keeps a manual collapse across resizes and later renders', () => {
  fitDetails(top, card, neighbour, details, 'balance'); paint();
  details.querySelector('summary').click();
  expect(details.open).toBe(false); expect(prefs.dailyDetails.balance).toBe(false);
  leftHeight = 700; resize(); paint(); expect(details.open).toBe(false);
  fitDetails(top, card, neighbour, details, 'balance'); paint(); expect(details.open).toBe(false);
});
