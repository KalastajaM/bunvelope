// @vitest-environment jsdom
// The card's "X of Y spent" line and its meter set this month's spend against
// this month's calendar plan (`monthPlanned`), not the annual average:
// Allowance Boys (2026-10-04), two 100 allowances due in April and October,
// read "€200,00 of €33,33 spent" in red beside "2 of 2 items on track".
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { envelopeCard } from '../js/ui/envelope-card.js';

const env = { id: 'boys', name: 'Allowance Boys', category: 'finance' };
const card = (props) => envelopeCard({ envelope: env, balance: 400, planned: 33.33, spare: { spare: 400 }, ...props });
const line = (el) => el.querySelector('.env-spent-line');

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 0); });

describe('envelope card, spent against the month\'s plan', () => {
  it('compares with monthPlanned and is not over plan when the month went as planned', () => {
    const el = card({ monthPlanned: 200, spent: 200 });
    expect(line(el).textContent).toMatch(/200[.,]00 .*200[.,]00/);
    expect(line(el).textContent).not.toMatch(/33[.,]33/);
    expect(line(el).classList.contains('is-over-plan')).toBe(false);
    expect(el.querySelector('.env-meter').classList.contains('is-over')).toBe(false);
  });

  it('is over plan past the month\'s plan', () => {
    const el = card({ monthPlanned: 200, spent: 250 });
    expect(line(el).classList.contains('is-over-plan')).toBe(true);
    expect(el.querySelector('.env-meter').classList.contains('is-over')).toBe(true);
  });

  it('overspent with an empty envelope is the same red state, not tight (orange)', () => {
    const el = card({ balance: 0, planned: 100, monthPlanned: 100, spent: 400, spare: { spare: 0 } });
    expect(el.classList.contains('low')).toBe(false);
    expect(line(el).classList.contains('is-over-plan')).toBe(true);
    expect(el.querySelector('.env-meter').classList.contains('is-over')).toBe(true);
    expect(el.querySelector('.env-meter').classList.contains('is-tight')).toBe(false);
  });

  it('a month the plan leaves empty says so, with or without spending', () => {
    expect(line(card({ monthPlanned: 0, spent: 0 })).textContent).toBe('nothing planned this month');
    const el = card({ monthPlanned: 0, spent: 50 });
    expect(line(el).textContent).toMatch(/50[.,]00 spent · nothing planned this month/);
    expect(line(el).classList.contains('is-over-plan')).toBe(false);
  });

  it('a caller without monthPlanned keeps the average', () => {
    expect(line(card({ spent: 20 })).textContent).toMatch(/20[.,]00 .*33[.,]33/);
  });
});
