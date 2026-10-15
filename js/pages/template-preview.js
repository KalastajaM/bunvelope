import { state, session } from '../app.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { t, trEnv } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { describeError } from '../core/errors.js';
import { node } from '../ui/planning-workspace.js';

// All effects come from the exact command, including date-sensitive Set lines,
// scheduled funding sources and the skipped occurrence when running early.
export function templatePreview({ form, host, button, input, token }) {
  let request = 0, ready = null;
  const refs = () => [state.transactions, state.envelopeTemplates, state.envelopes, state.accounts, state.budgetItems, state.meta];
  const sameRefs = (a) => a?.every((x, i) => x === refs()[i]);
  async function refresh() {
    const id = ++request;
    ready = null; button.disabled = true;
    host.replaceChildren(node('p', 'muted', t('overview.previewLoading')));
    const args = input(), beforeRefs = refs();
    try {
      const before = ['today','booked'].map(lens => session.query('balances', { lens }));
      const [dry, ...after] = await Promise.all([
        session.dispatch('allocation.fill', args, { dryRun: true }),
        ...['today','booked'].map(lens => session.queryAfter([{ name:'allocation.fill', input:args }], 'balances', { lens })),
      ]);
      if (id !== request || token !== currentBudgetSession() || !form.isConnected) return;
      if (!sameRefs(beforeRefs)) { await refresh(); return; }
      const failed = [...before, dry, ...after].find(r => !r.ok);
      if (failed) { host.replaceChildren(node('p', 'workspace-warning', describeError(failed.error, t))); return; }
      const fill = dry.value.value;
      const source = fill.source_envelope_id;
      const sourceEnv = state.envelopes.find(e => e.id === source);
      host.replaceChildren(node('h3', '', t('workspace.executionPreview')),
        node('p', '', t('workspace.drawsFrom') + ': ' + (sourceEnv ? trEnv(sourceEnv) : t('nav.unallocated'))));
      const table = node('table', 'workspace-preview-table');
      const head = node('tr');
      for (const text of [t('workspace.balance'),t('workspace.before'),t('workspace.after')]) head.append(node('th','',text));
      const thead = node('thead'); thead.append(head); table.append(thead);
      const tbody = node('tbody'); table.append(tbody);
      const add = (label, a, b) => {
        const row = node('tr'); row.append(node('th','',label),node('td','',fmt(a)),node('td', b < -0.005 ? 'workspace-negative' : '',fmt(b))); tbody.append(row);
      };
      for (let i=0;i<2;i++) add(t('overview.poolBasis')(t('lens.'+['today','booked'][i])), before[i].value.unallocated, after[i].value.unallocated);
      host.append(table);
      if (after.some(r => r.value.unallocated < -0.005)) host.append(node('p','workspace-warning',t('workspace.poolWarning')));
      const effects = node('div', 'workspace-effects');
      effects.append(node('h4','',t('workspace.envelopeEffects')));
      for (const line of fill.lines) {
        const env = state.envelopes.find(e => e.id === line.envelope_id);
        const a = before[1].value.envelopes.find(e => e.id === line.envelope_id)?.balance ?? 0;
        const b = after[1].value.envelopes.find(e => e.id === line.envelope_id)?.balance ?? 0;
        effects.append(node('p','',`${env ? trEnv(env) : line.envelope_id}: ${fmt(a)} → ${fmt(b)} (${fmt(line.amount, { signed:true })})`));
      }
      if (source && after[1].value.envelopes.some(e => e.id === source && e.balance < -0.005)) host.append(node('p', 'workspace-warning', t('workspace.sourceWarning')));
      host.append(effects, node('p','muted',t('overview.previewOnly')));
      ready = { key:JSON.stringify(args), refs:beforeRefs };
      button.disabled = false;
    } catch (error) {
      console.error(error);
      if (id === request && token === currentBudgetSession() && form.isConnected) host.replaceChildren(node('p','workspace-warning',t('overview.unavailable')));
    }
  }
  return { refresh, valid: () => token === currentBudgetSession() && ready?.key === JSON.stringify(input()) && sameRefs(ready?.refs) };
}
