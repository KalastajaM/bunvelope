// js/pages/insights.js — AI Insights subpage. Hosts the Monthly briefing
// card and the Anomaly alerts card so the Dashboard stays focused on
// numbers. Both cards self-fetch; "Refresh all" busts each card's server
// cache via the existing `noCache: true` flag.

import { addPageHelp } from '../ui/info-button.js';
import { navigate } from '../app.js';
import { state } from '../app.js';
import { t } from '../ui/i18n.js';
import { isRelayFeatureAvailable, isAiFeatureEnabled, aiInsights } from '../ai/client.js';
import { renderAiCard, withAiState } from '../ai/render.js';
import { formatAiText } from '../ai/money-text.js';
import { moneyEl } from '../ui/money.js';
import { validateAmount } from '../utils.js';
import { dismissItem } from '../ai/consent.js';
import { anomalyKey } from '../ai/context-builder.js';
import { openEnvelopeEdit } from './envelope-edit.js';
import { icon } from '../ui/icon.js';

export async function render(container) {
  if (!isRelayFeatureAvailable()) {
    const page = document.createElement('div');
    page.className = 'page page-insights';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const msg = document.createElement('p');
    msg.textContent = t('ai.error.disabled');
    empty.append(msg);
    page.append(empty);
    container.append(page);
    return;
  }

  const page = document.createElement('div');
  page.className = 'page page-insights';

  // Page head with refresh-all action.
  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('ai.insights.title');
  addPageHelp(h1, 'tour.steps.insights.body', { tooltipKey: 'ai.insights.sub' });
  left.append(h1);
  head.append(left);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const refreshAll = document.createElement('button');
  refreshAll.type = 'button';
  refreshAll.className = 'btn btn-ghost';
  refreshAll.textContent = t('ai.insights.refreshAll');
  actions.append(refreshAll);
  head.append(actions);
  page.append(head);

  // Cards. Each builder returns the card and exposes a `refresh(noCache)`
  // method we can call from the toolbar.
  const cards = [];
  if (isAiFeatureEnabled('monthlyBriefing')) cards.push(buildAiBriefingCard());
  if (isAiFeatureEnabled('anomaly'))         cards.push(buildAiAnomalyCard());
  if (isAiFeatureEnabled('envelopeHealth'))  cards.push(buildAiHealthCard());

  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const msg = document.createElement('p');
    msg.textContent = t('ai.error.disabled');
    empty.append(msg);
    page.append(empty);
  } else {
    for (const c of cards) page.append(c.card);
  }

  refreshAll.addEventListener('click', () => {
    for (const c of cards) c.refresh(true);
  });

  container.append(page);
}

// ── Briefing card ────────────────────────────────────────────────────────

function buildAiBriefingCard() {
  let card, body;
  function load(noCache = false) {
    withAiState(body, async (signal) => {
      const out = await aiInsights('monthly_briefing', { signal, noCache });
      renderBriefing(body, out);
    });
  }
  ({ card, body } = renderAiCard({
    titleKey: 'ai.briefing.title',
    subKey: 'ai.briefing.sub',
    onRefresh: () => load(true),
  }));
  load(false);
  return { card, refresh: load };
}

function renderBriefing(host, out) {
  host.replaceChildren();
  if (out?.headline) {
    const p = document.createElement('p');
    p.className = 'ai-headline';
    p.textContent = formatAiText(out.headline);
    host.append(p);
  }
  if (Array.isArray(out?.bullets) && out.bullets.length) {
    const ul = document.createElement('ul');
    ul.className = 'ai-bullet-list';
    for (const b of out.bullets) {
      const li = document.createElement('li');
      li.textContent = formatAiText(b);
      ul.append(li);
    }
    host.append(ul);
  }
  if (out?.cta && out.cta.label && out.cta.kind) {
    const targets = new Set(['envelopes', 'review', 'transactions']);
    if (targets.has(out.cta.kind)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.style.marginTop = '8px';
      btn.textContent = formatAiText(out.cta.label);
      btn.addEventListener('click', () => navigate(out.cta.kind));
      host.append(btn);
    }
  }
}

// ── Anomaly alerts card ──────────────────────────────────────────────────

function buildAiAnomalyCard() {
  let card, body;
  function load(noCache = false) {
    withAiState(body, async (signal) => {
      const out = await aiInsights('anomaly', { signal, noCache });
      renderAnomalies(body, out);
    });
  }
  ({ card, body } = renderAiCard({
    titleKey: 'ai.anomaly.title',
    subKey: 'ai.anomaly.sub',
    onRefresh: () => load(true),
  }));
  load(false);
  return { card, refresh: load };
}

function renderAnomalies(host, out) {
  host.replaceChildren();
  const alerts = Array.isArray(out?.alerts) ? out.alerts : [];
  if (!alerts.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-error';
    empty.textContent = t('ai.anomaly.empty');
    host.append(empty);
    return;
  }
  for (const a of alerts) {
    const row = document.createElement('div');
    row.className = 'ai-row';
    const dot = document.createElement('span');
    dot.className = 'ai-dot ' + (a.severity === 'warn' ? 'ai-dot-warn' : 'ai-dot-info');
    row.append(dot);
    const text = document.createElement('div');
    text.style.flex = '1';
    const message = formatAiText(a.message || '');
    text.textContent = message;
    row.append(text);
    // The numeric field is the app's own formatting of the amount; the prose
    // may or may not mention it, so show it in its own slot.
    const amount = validateAmount(a.amount);
    if (amount !== null) {
      const amt = moneyEl(amount, { size: 'inline' });
      amt.style.cssText = 'flex:0 0 auto;white-space:nowrap;font-size:13px;color:var(--muted);';
      row.append(amt);
    }
    if (a.envelope_id) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn-ghost btn-icon';
      open.title = t('ai.anomaly.open');
      open.setAttribute('aria-label', t('ai.anomaly.open'));
      open.append(icon('chevronR', 18));
      open.addEventListener('click', () => navigate('transactions', { envelope: a.envelope_id }));
      row.append(open);
    }

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-ghost btn-icon';
    dismiss.textContent = '×';
    dismiss.title = t('ai.dismiss');
    dismiss.setAttribute('aria-label', t('ai.dismiss'));
    // Persist locally; do NOT re-call the LLM. The dismissed filter in
    // context-builder will exclude this row on the next manual refresh.
    dismiss.addEventListener('click', async () => {
      const key = anomalyKey(a.envelope_id, a.payee, a.amount);
      try { await dismissItem('anomaly', key, message); }
      catch (err) { console.error('dismiss anomaly failed', err); }
      row.remove();
      if (!host.querySelector('.ai-row')) {
        const empty = document.createElement('div');
        empty.className = 'ai-error';
        empty.textContent = t('ai.anomaly.empty');
        host.append(empty);
      }
    });
    row.append(dismiss);

    host.append(row);
  }
}

// ── Envelope health card ─────────────────────────────────────────────────

function buildAiHealthCard() {
  let card, body;
  function load(noCache = false) {
    withAiState(body, async (signal) => {
      const out = await aiInsights('envelope_health', { signal, noCache });
      renderHealth(body, out);
    });
  }
  ({ card, body } = renderAiCard({
    titleKey: 'ai.health.title',
    subKey: 'ai.health.sub',
    onRefresh: () => load(true),
  }));
  load(false);
  return { card, refresh: load };
}

function renderHealth(host, out) {
  host.replaceChildren();
  const rows = Array.isArray(out?.rows) ? out.rows : [];
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-error';
    empty.textContent = t('ai.health.empty');
    host.append(empty);
    return;
  }
  const envById = new Map((state.envelopes || []).map((e) => [e.id, e]));
  for (const r of rows) {
    const env = envById.get(r.envelope_id);
    if (!env) continue;
    const row = document.createElement('div');
    row.className = 'ai-row';
    row.tabIndex = 0;
    row.style.cursor = 'pointer';
    const dotClass = {
      ok: 'ai-dot-ok',
      underfunded: 'ai-dot-under',
      overfunded: 'ai-dot-over',
      stale: 'ai-dot-stale',
    }[r.status] || 'ai-dot-info';
    const dot = document.createElement('span');
    dot.className = 'ai-dot ' + dotClass;
    row.append(dot);

    const text = document.createElement('div');
    text.style.flex = '1';
    const name = document.createElement('div');
    name.style.fontWeight = '500';
    name.textContent = env.name;
    const note = document.createElement('div');
    note.className = 'sub';
    note.style.fontSize = '12.5px';
    note.style.color = 'var(--muted)';
    note.textContent = formatAiText(r.note || '');
    text.append(name, note);
    row.append(text);

    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;';
    badge.textContent = t({
      ok: 'ai.health.statusOk',
      underfunded: 'ai.health.statusUnder',
      overfunded: 'ai.health.statusOver',
      stale: 'ai.health.statusStale',
    }[r.status] || 'ai.health.statusOk');
    row.append(badge);

    // Dismiss this envelope from future health suggestions until restored
    // from Settings → AI → Hidden suggestions. No LLM re-call here.
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-ghost btn-icon';
    dismiss.textContent = '×';
    dismiss.title = t('ai.dismiss');
    dismiss.setAttribute('aria-label', t('ai.dismiss'));
    dismiss.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await dismissItem('envelope_health', env.id, env.name); }
      catch (err) { console.error('dismiss health failed', err); }
      row.remove();
      if (!host.querySelector('.ai-row')) {
        const empty = document.createElement('div');
        empty.className = 'ai-error';
        empty.textContent = t('ai.health.empty');
        host.append(empty);
      }
    });
    row.append(dismiss);

    const open = () => openEnvelopeEdit(env.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    host.append(row);
  }
}
