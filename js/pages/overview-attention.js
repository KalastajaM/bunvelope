import { state, navigate } from '../app.js';
import { t, fmtDateLang, trEnv } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { openEnvelopeFunding } from './envelope-funding.js';
import { openEnvelopeEdit } from './envelope-edit.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function updateOverviewAttention(host, answer, openEnvelope) {
  if (!host) return;
  host.replaceChildren();
  if (!answer) { host.append(el('p', 'muted', t('overview.unavailable'))); return; }
  const { items, incomplete } = answer;
  host.append(el('p', 'sub', `${fmtDateLang(answer.start)} – ${fmtDateLang(answer.end)}`));
  if (!items.length) host.append(el('p', incomplete.length ? 'muted' : 'overview-covered',
    t(incomplete.length ? 'attention.partialClear' : 'attention.clear')));
  const itemName = item => {
    const env = state.envelopes.find(e => e.id === item.id);
    return item.kind === 'account' ? item.name : env ? trEnv(env) : item.name;
  };
  const valuesOf = item => ({ date: fmtDateLang(item.date), amount: fmt(item.gap), balance: fmt(item.balance),
    projected: fmt(item.projected), target: fmt(item.target), floor: fmt(item.floor),
    low: item.low ? fmt(item.low.balance) : '', lowDate: item.low ? fmtDateLang(item.low.date) : '' });
  const row = item => {
    const node = el('div', 'overview-attention-row');
    node.dataset.attentionKey = item.key;
    const copy = el('div', 'overview-attention-copy');
    const name = itemName(item);
    const values = valuesOf(item);
    const summaryKey = item.kind === 'goal' ? item.overdue ? 'overdue' : item.deadline ? 'goal' : 'goalNoDate' : item.kind === 'account' && item.estimated ? 'accountEstimated' : item.kind;
    copy.append(el('strong', '', name), el('p', '', t(`attention.${summaryKey}`)(values)));
    const action = el('button', 'btn btn-sm btn-ghost', t(`attention.review${item.kind}`));
    action.type = 'button';
    action.setAttribute('aria-label', `${action.textContent}: ${name}`);
    action.addEventListener('click', () => {
      if (item.kind === 'account') navigate('transactions', `account:${item.id}`);
      else if (item.kind === 'goal') {
        const current = state.envelopes.find(e => e.id === item.id && !e.archived);
        if (current) openEnvelopeEdit(current);
      } else openEnvelope(item.id);
    });
    const actions = el('div', 'attention-actions');
    actions.append(action);
    if (item.kind === 'envelope') {
      const help = el('button', 'btn btn-sm btn-ghost', t('funding.title'));
      help.type = 'button'; help.setAttribute('aria-label', `${t('funding.title')}: ${name}`);
      help.addEventListener('click', () => openEnvelopeFunding(item.id));
      actions.append(help);
    }
    node.append(copy, actions);
    return node;
  };
  const appendGroups = (parent, entries) => {
    // Keep chronological priority and the three-item preview. Only neighbours
    // with the same kind of warning share a disclosure.
    const groups = [];
    for (const item of entries) {
      const key = `${item.kind}:${!!item.estimated}:${!!item.overdue}:${!!item.deadline}`;
      if (groups.at(-1)?.key === key) groups.at(-1).items.push(item);
      else groups.push({ key, items: [item] });
    }
    for (const group of groups) {
      const section = el('div', 'attention-group');
      group.items.forEach(item => section.append(row(item)));
      const why = el('details', 'attention-explanation');
      const first = group.items[0];
      why.append(el('summary', '', t(group.items.length > 1 ? 'attention.whyPlural' : 'attention.why')));
      if (group.items.length === 1) why.append(el('p', 'sub', t(`attention.${first.kind}Why`)(valuesOf(first))));
      else {
        why.append(el('p', 'sub', t(`attention.${first.kind}WhyShared`)));
        const facts = el('dl', 'attention-facts');
        for (const item of group.items) {
          facts.append(el('dt', '', itemName(item)), el('dd', '', t(`attention.${item.kind}Facts`)(valuesOf(item))));
        }
        why.append(facts);
      }
      if (first.estimated) why.append(el('p', 'sub', t('spendingProfile.warning')));
      section.append(why); parent.append(section);
    }
  };
  const list = el('div', 'overview-attention-list');
  appendGroups(list, items.slice(0, 3));
  host.append(list);
  if (items.length > 3) {
    const more = el('details', 'overview-more-gaps');
    more.append(el('summary', '', t('attention.more')(items.length - 3)));
    appendGroups(more, items.slice(3));
    host.append(more);
  }
  if (incomplete.length) {
    const details = el('details', 'attention-incomplete');
    details.append(el('summary', '', t('attention.incomplete')(incomplete.length)));
    for (const item of incomplete) details.append(el('p', 'sub', `${item.name}: ${t(`attention.unassessed${item.kind}`)}`));
    host.append(details);
  }
}
