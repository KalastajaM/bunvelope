// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { updateOverviewAttention } from '../js/pages/overview-attention.js';
import { t } from '../js/ui/i18n.js';
import { state, resetState, mountHosts, navigate, writeBatch } from './_fakes/pageApp.js';

let host;
const response = (items = [], incomplete = []) => ({ start: '2026-09-15', end: '2027-09-14', items, incomplete });
const account = { key: 'account:chk', kind: 'account', id: 'chk', name: 'Checking', date: '2026-09-20', balance: -20, low: { date: '2026-10-10', balance: -40 } };
beforeEach(() => { resetState(); mountHosts(); host = document.getElementById('app-root'); navigate.mockClear(); });

describe('attention actions', () => {
  it('shares a reserve explanation while retaining each envelope’s figures and actions', () => {
    const env = { kind: 'envelope', date: '2026-09-20', gap: 20, floor: 30, low: { date: '2026-09-20', balance: 10 } };
    updateOverviewAttention(host, response([
      { ...env, id: 'culture', key: 'envelope:culture', name: 'Culture' },
      { ...env, id: 'hobbies', key: 'envelope:hobbies', name: 'Hobbies', gap: 100 }, account,
    ]), vi.fn());
    expect(host.querySelectorAll('.attention-explanation')).toHaveLength(2);
    const shared = host.querySelector('.attention-explanation');
    expect(shared.querySelector('summary').textContent).toBe('Why are these flagged?');
    expect(shared.textContent).toContain('Culture');
    expect(shared.textContent).toContain('Hobbies');
    expect(host.querySelectorAll('[data-attention-key]')).toHaveLength(3);
  });
  it('shows three entries initially, keeps the rest expandable and routes account activity', () => {
    const items = [account, ...[1, 2, 3].map(i => ({ ...account, id: String(i), key: `account:${i}` }))];
    updateOverviewAttention(host, response(items), vi.fn());
    expect(host.querySelectorAll('.overview-attention-list [data-attention-key]')).toHaveLength(3);
    expect(host.querySelector('.overview-more-gaps').open).toBe(false);
    expect(host.querySelector('.overview-more-gaps [data-attention-key]')).not.toBeNull();
    host.querySelector('button').click();
    expect(navigate).toHaveBeenCalledWith('transactions', 'account:chk');
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('opens the named envelope and goal without writing', () => {
    const open = vi.fn();
    const env = { key: 'envelope:food', kind: 'envelope', id: 'food', name: 'Food', date: '2026-09-20', gap: 20, floor: 30, low: { date: '2026-09-20', balance: 10 } };
    const goal = { key: 'goal:food', kind: 'goal', id: 'food', name: 'Food', date: '2026-10-20', gap: 20, projected: 100, target: 120, deadline: '2026-10-20' };
    updateOverviewAttention(host, response([env, goal]), open);
    host.querySelector('[data-attention-key="envelope:food"] button').click(); expect(open).toHaveBeenCalledWith('food');
    const before = structuredClone(state.envelopes);
    host.querySelector('[data-attention-key="goal:food"] button').click();
    expect(document.querySelector('.sheet')).not.toBeNull();
    expect(state.envelopes).toEqual(before); expect(writeBatch).not.toHaveBeenCalled();
  });
  it('never shows an all-clear state when coverage is incomplete or the query failed', () => {
    updateOverviewAttention(host, response([], [{ kind: 'goal', id: 'food', name: 'Food' }]), vi.fn());
    expect(host.textContent).toContain(t('attention.partialClear'));
    expect(host.textContent).not.toContain(t('attention.clear'));
    expect(host.querySelector('.attention-incomplete')).not.toBeNull();
    updateOverviewAttention(host, null, vi.fn());
    expect(host.textContent).toBe(t('overview.unavailable'));
  });
  it('replaces stale warnings on refresh and renders untrusted names as text', () => {
    updateOverviewAttention(host, response([{ ...account, name: '<img src=x onerror=alert(1)>' }]), vi.fn());
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    updateOverviewAttention(host, response(), vi.fn());
    expect(host.querySelector('[data-attention-key]')).toBeNull();
    expect(host.textContent).toContain(t('attention.clear'));
  });
});
