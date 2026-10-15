// @vitest-environment jsdom
// The envelope health check opens on the balance the envelope card shows (the
// active lens), and says where the projection starts when that differs.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openEnvelopeHealth } from '../js/pages/envelope-health.js';
import { t } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { state, resetState, mountHosts, prefs } from './_fakes/pageApp.js';

const tileText = () => document.querySelector('#sheet-host .health-balance-tile').textContent.replace(/\s/g, '');
const squash = (s) => s.replace(/\s/g, '');

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState({
    transactions: [
      { id: 'f', type: 'fill', date: '2026-09-01', status: 'posted', lines: [{ envelope_id: 'food', mode: 'add', amount: 200 }] },
    ],
  });
  mountHosts();
});

describe('health check balance tile', () => {
  it('shows the lens balance; no second line when the projection starts from it', () => {
    prefs.lens = 'booked';
    openEnvelopeHealth(state.envelopes[0]);
    expect(tileText()).toContain(squash(t('health.balanceLabel')(t('lens.booked'))));
    expect(tileText()).toContain(squash(fmt(200)));
    expect(tileText()).not.toContain(squash(t('health.projectionStartsFrom')('')));
  });

  it('a future-dated expense in Booked: the tile matches the card and names where the projection starts', () => {
    prefs.lens = 'booked';
    state.transactions = [
      ...state.transactions,
      { id: 'e', type: 'expense', date: '2026-09-25', status: 'posted', amount: 50, envelope_id: 'food', account: 'chk' },
    ];
    openEnvelopeHealth(state.envelopes[0]);
    expect(tileText()).toContain(squash(fmt(150)));
    expect(tileText()).toContain(squash(t('health.projectionStartsFrom')(fmt(200))));
  });
});
