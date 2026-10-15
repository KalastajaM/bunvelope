// Phone-width layout rules (BACKLOG 2026-10-05, checked at 390x844): the
// Transactions toolbar wraps instead of pushing "Ask AI" off the screen,
// Reports' paired cards stack, wide tables scroll inside their card with a
// sticky first column and an edge cue, small icon buttons get a larger hit
// area, and the page keeps its last row clear of the fixed status bar. The
// pages carry the hooks these rules select.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const mobile = read('css/mobile.css');
const app = read('css/app.css');

/** The body of the phone breakpoint in css/mobile.css. */
function phoneBlock() {
  const start = mobile.indexOf('@media (max-width: 840px)');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = mobile.indexOf('{', start); i < mobile.length; i++) {
    if (mobile[i] === '{') depth++;
    else if (mobile[i] === '}' && --depth === 0) return mobile.slice(start, i);
  }
  throw new Error('unbalanced');
}
const phone = phoneBlock();
const rule = (css, selector) => {
  const i = css.indexOf(selector);
  return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
};

describe('phone breakpoint', () => {
  it('wraps the Transactions search row', () => {
    expect(rule(phone, '.tx-search-row {')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(phone, '.tx-search-row > .search')).toMatch(/flex-basis:\s*100%/);
  });
  it('stacks the Reports pairs', () => {
    expect(rule(phone, '.reports-pair')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
  it('scrolls the Settings tabs inside their strip', () => {
    expect(rule(phone, '.content-tabs {')).toMatch(/overflow-x:\s*auto/);
  });
  it('scrolls the Stress rows inside the card with the scenario pinned', () => {
    expect(rule(phone, '.stress-table {')).toMatch(/overflow-x:\s*auto/);
    expect(rule(phone, '.stress-row > :first-child')).toMatch(/position:\s*sticky/);
  });
  it('pins the first column of the Review and Net worth tables', () => {
    expect(rule(phone, '#review-table-wrap :is(th, td:not([colspan])):first-child')).toMatch(/position:\s*sticky/);
  });
  it('enlarges the hit area of small icon buttons to at least 36px', () => {
    expect(rule(phone, '.info-btn::after')).toMatch(/inset:\s*-8px/);
  });
  it('reserves room under the page for the fixed status bar', () => {
    expect(rule(phone, '.main {')).toMatch(/padding:[^;]*72px/);
  });
});

describe('scroll cue styles', () => {
  it('fades an edge that hides content, at any width', () => {
    expect(app).toMatch(/\[data-scroll-cue\]\[data-scroll-end\]\s*\{[^}]*mask-image/);
  });
});

describe('page hooks', () => {
  it('marks the wide tables for the scroll cue', () => {
    expect(read('js/pages/review.js')).toMatch(/id="review-table-wrap" data-scroll-cue="sticky"/);
    expect(read('js/pages/stress.js')).toMatch(/class="stress-table" data-scroll-cue="sticky"/);
    expect(read('js/pages/net-worth.js')).toMatch(/setAttribute\('data-scroll-cue', 'sticky'\)/);
    expect(read('js/pages/investments.js')).toMatch(/inv-holdings-scroll/);
  });
  it('lays the Transactions toolbar out by class, not a fixed inline row', () => {
    const src = read('js/pages/transactions.js');
    expect(src).toMatch(/searchRow\.className = 'tx-search-row'/);
    expect(src).not.toMatch(/search\.style\.flex = '1'/);
  });
  it('pairs the Reports cards by class', () => {
    const src = read('js/pages/reports.js');
    expect(src).toMatch(/class="reports-pair"/);
    expect(src).not.toMatch(/grid-template-columns:repeat\(2/);
  });
});
