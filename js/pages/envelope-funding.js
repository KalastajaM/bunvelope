import { state, session, navigate } from '../app.js';
import { currentBudgetSession, onBudgetSessionChange } from '../state/budget-session.js';
import { subscribeState } from '../state/events.js';
import { t, fmtDateLang } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { openSheet } from '../ui/sheet.js';
import { paintYield } from '../ui/skeleton.js';
import { toast } from '../ui/toast.js';
import { undoAction } from '../ui/undo-action.js';
import { reportDispatchFailure } from '../ui/save-error.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, action, cls = 'btn btn-sm btn-ghost') => {
  const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node;
};

export function openEnvelopeFunding(envelope) {
  const owner = currentBudgetSession();
  let closed = false, busy = false, generation = 0, report = null;
  const selected = new Set();
  const live = () => !closed && owner === currentBudgetSession();
  const content = el('div', 'envelope-funding');
  const results = el('div', 'funding-results'); results.setAttribute('aria-live', 'polite');
  const apply = button(t('funding.apply'), save, 'btn btn-accent'); apply.disabled = true; apply.hidden = true;
  const preview = button(t('funding.preview'), () => { void check(true); }, 'btn btn-accent'); preview.disabled = true;
  const refresh = button(t('funding.refresh'), () => { selected.clear(); void check(); });
  const effects = el('div', 'funding-effects'); effects.setAttribute('aria-live', 'polite'); effects.tabIndex = -1;
  const selection = el('p', 'sub funding-selection'); selection.setAttribute('aria-live', 'polite');
  const actions = el('div', 'purchase-actions'); actions.append(preview, refresh);
  content.append(el('p', 'sub', t('funding.intro')), results, selection, actions, effects, apply, el('p', 'sub', t('funding.scope')));
  const sheet = openSheet({ title: t('funding.title'), content, wide: true,
    onClose: () => { closed = true; offBudget(); offState(); } });
  const offBudget = onBudgetSessionChange(() => { closed = true; sheet.close(); });
  const offState = subscribeState(() => { if (!busy && live()) invalidate(); });
  void check();

  function invalidate() {
    generation++; report = null; selected.clear(); apply.disabled = true; apply.hidden = true; preview.disabled = true; effects.replaceChildren(); selection.textContent = '';
    results.replaceChildren(el('p', 'sub', t('funding.stale')));
  }
  async function check(withPreview = false) {
    if (!live() || busy) return;
    const ticket = ++generation; report = null; apply.disabled = true; apply.hidden = true; preview.disabled = true; effects.replaceChildren();
    results.replaceChildren(el('p', 'sub', t('common.loading')));
    await paintYield();
    if (!live() || ticket !== generation) return;
    try {
      const r = session.query('envelope.funding', { envelope, ...(withPreview ? { sources: [...selected] } : {}) });
      if (!r.ok) { results.replaceChildren(el('p', 'sub', t('funding.unavailable'))); return; }
      report = r.value; render(report); apply.disabled = !report.preview?.canApply; apply.hidden = !report.preview;
      if (report.preview) {
        effects.focus({ preventScroll: true });
        effects.scrollIntoView?.({ block: 'start' });
      }
    } catch (error) {
      console.warn('[bunvelope] funding preview failed', error);
      results.replaceChildren(el('p', 'sub', t('funding.unavailable')));
    }
  }
  function values(label, before, after) {
    const row = el('div', 'purchase-value');
    row.append(el('span', '', label), el('strong', '', `${fmt(before)} → ${fmt(after)}`)); return row;
  }
  function render(r) {
    results.replaceChildren(el('h3', '', r.envelope.name));
    results.append(el('p', 'sub', `${fmtDateLang(r.date)} – ${fmtDateLang(r.end)}`), el('p', '', `${t('funding.gap')}: ${fmt(r.gap)}`));
    if (!r.gap) results.append(el('p', 'sub', t('funding.noGap')));
    else if (!r.candidates.length) results.append(el('p', 'sub', t('funding.noSources')));
    else {
      results.append(el('p', 'sub', t('funding.candidates')));
      const list = el('fieldset', 'funding-sources');
      list.append(el('legend', '', t('funding.choose')));
      const heading = el('div', 'funding-source-heading');
      heading.append(el('span', '', t('funding.envelope')), el('span', '', t('funding.available')));
      list.append(heading);
      const rows = el('div', 'funding-source-list');
      for (const c of r.candidates) {
        const row = el('label', 'funding-source');
        const checkbox = el('input', ''); checkbox.type = 'checkbox'; checkbox.checked = selected.has(c.id);
        checkbox.setAttribute('aria-label', c.name);
        checkbox.addEventListener('change', () => {
          if (!live() || busy) { checkbox.checked = selected.has(c.id); return; }
          if (checkbox.checked) selected.add(c.id); else selected.delete(c.id);
          generation++; report = null; apply.disabled = true; apply.hidden = true; effects.replaceChildren(); updateSelection();
        });
        row.append(checkbox, el('span', 'funding-source-name', c.name), el('strong', 'funding-source-amount', fmt(c.available)));
        rows.append(row);
      }
      list.append(rows); results.append(list);
    }
    updateSelection();
    if (!r.preview) return;
    const p = r.preview;
    effects.append(el('h3', '', t('funding.preview')), el('p', '', `${t('funding.total')}: ${fmt(p.total)}`));
    effects.append(el('p', 'sub', t('funding.contributions')));
    for (const source of p.sources) effects.append(el('p', 'funding-contribution', `${source.name} → ${r.envelope.name}: ${fmt(source.amount)}`));
    effects.append(el('h4', p.canApply ? '' : 'purchase-warning', t(p.canApply ? p.remainingGap > 0 ? 'funding.partial' : 'funding.covered' : 'funding.blocked')));
    effects.append(el('p', '', `${t('funding.remaining')}: ${fmt(p.remainingGap)}`));
    for (const c of p.changes) {
      effects.append(values(`${c.name} · ${t('purchase.spare')}`, c.before.spare, c.after.spare));
      effects.append(el('p', 'sub', `${t('purchase.lowOn')}: ${fmtDateLang(c.after.low.date)} · ${fmt(c.after.low.balance)}`));
    }
    for (const b of p.blockers) effects.append(el('p', 'purchase-warning', `${b.name}: ${t('funding.blockers.' + b.kind)}`));
    if (p.goals.length) effects.append(el('h4', '', t('purchase.goals')));
    for (const g of p.goals) {
      effects.append(el('p', 'sub', `${g.name} · ${t('purchase.goalStatuses.' + g.before.status)} → ${t('purchase.goalStatuses.' + g.after.status)}`));
      if (g.after.projected !== null) effects.append(values(`${fmtDateLang(g.after.date)} · ${t('purchase.target')} ${fmt(g.after.target)}`, g.before.projected, g.after.projected));
      else effects.append(el('p', 'sub', `${t('purchase.outside')}: ${fmtDateLang(g.after.date)}`));
    }
  }
  function updateSelection() {
    preview.disabled = !selected.size || busy;
    selection.textContent = t('funding.selected')(selected.size);
  }
  async function save() {
    if (!live() || busy || !report?.preview?.canApply) return;
    let fresh;
    try { fresh = session.query('envelope.funding', { envelope, sources: [...selected] }); } catch { fresh = null; }
    if (!fresh?.ok || JSON.stringify(fresh.value) !== JSON.stringify(report)) { invalidate(); return; }
    busy = true; preview.disabled = true;
    results.querySelectorAll('input').forEach(input => { input.disabled = true; });
    apply.disabled = true; refresh.disabled = true;
    try {
      const result = await session.dispatchBatch([{ name: 'envelope.fund', input: { envelope, sources: [...selected], expected: JSON.stringify(report) } }]);
      if (!live()) return;
      if (!result.ok) { reportDispatchFailure(result.error); return; }
      sheet.close();
      toast(t('funding.saved'), { action: undoAction(result.value.undo, state.currentPage) });
      navigate(state.currentPage);
    } catch (error) {
      console.warn('[bunvelope] funding save failed', error);
      if (live()) toast(t('funding.saveFailed'), { assertive: true });
    } finally {
      busy = false;
      if (live()) { refresh.disabled = false; invalidate(); }
    }
  }
}
