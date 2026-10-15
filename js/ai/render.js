// js/ai/render.js — shared UI primitives for AI cards.
// Card header, refresh button, async slot with skeleton + retry.

import { t } from '../ui/i18n.js';

/**
 * Build a standard `.card.ai-card` with title, optional subtitle, refresh
 * button, optional dismiss button, and a body host.
 *
 * @param {object} opts
 * @param {string} opts.titleKey   i18n key for the card title
 * @param {string} [opts.subKey]   i18n key for the card subtitle
 * @param {() => void} [opts.onRefresh]
 * @param {() => void} [opts.onDismiss]
 * @returns {{ card: HTMLElement, body: HTMLElement, setBusy: (b: boolean) => void }}
 */
export function renderAiCard({ titleKey, subKey, onRefresh, onDismiss } = {}) {
  const card = document.createElement('div');
  card.className = 'card ai-card';
  card.dataset.aiCard = '1';

  const head = document.createElement('div');
  head.className = 'card-title';
  head.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;';

  const titleWrap = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = titleKey ? t(titleKey) : '';
  titleWrap.append(h3);
  if (subKey) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = t(subKey);
    titleWrap.append(sub);
  }
  head.append(titleWrap);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;flex:0 0 auto;';

  let refreshBtn = null;
  if (onRefresh) {
    refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-ghost btn-icon';
    refreshBtn.title = t('ai.refresh');
    refreshBtn.setAttribute('aria-label', t('ai.refresh'));
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', () => onRefresh());
    actions.append(refreshBtn);
  }
  if (onDismiss) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'btn btn-ghost btn-icon';
    x.title = t('ai.dismiss');
    x.setAttribute('aria-label', t('ai.dismiss'));
    x.textContent = '×';
    x.addEventListener('click', () => onDismiss());
    actions.append(x);
  }
  head.append(actions);
  card.append(head);

  const body = document.createElement('div');
  body.className = 'ai-card-body';
  card.append(body);

  function setBusy(b) {
    if (refreshBtn) refreshBtn.disabled = !!b;
    card.dataset.aiBusy = b ? '1' : '0';
  }

  return { card, body, setBusy };
}

function makeSkeleton(lines = 3) {
  const wrap = document.createElement('div');
  wrap.className = 'ai-skeleton';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  for (let i = 0; i < lines; i++) {
    const row = document.createElement('div');
    row.style.cssText = `height:12px;border-radius:6px;background:linear-gradient(90deg,var(--bg-sunken,#eee),var(--surface,#f7f7f7),var(--bg-sunken,#eee));background-size:200% 100%;animation:ai-shimmer 1.4s infinite;width:${[100, 80, 60][i] || 70}%;`;
    wrap.append(row);
  }
  return wrap;
}

ensureShimmerKeyframes();

function ensureShimmerKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ai-shimmer-style')) return;
  const s = document.createElement('style');
  s.id = 'ai-shimmer-style';
  s.textContent = `
    @keyframes ai-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
    .ai-card .ai-card-body { margin-top: 8px; }
    .ai-error { color: var(--muted); font-size: 13px; display:flex; align-items:center; gap:8px; }
    .ai-bullet-list { margin: 0; padding-left: 18px; }
    .ai-bullet-list li { margin: 4px 0; line-height: 1.5; }
    .ai-headline { margin: 0 0 6px; font-weight: 600; }
    .ai-row { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--border,#eee); }
    .ai-card-body > .ai-row:first-child { border-top: 0; }
    .ai-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
    .ai-dot-info { background: var(--accent, #10b981); }
    .ai-dot-warn { background: #f59e0b; }
    .ai-dot-ok   { background: #10b981; }
    .ai-dot-under{ background: #ef4444; }
    .ai-dot-over { background: #f59e0b; }
    .ai-dot-stale{ background: #9ca3af; }
  `;
  document.head.append(s);
}

/**
 * Run an async producer inside a host element, swapping a skeleton for the
 * resulting content. AbortController auto-aborts when the host disconnects.
 */
export async function withAiState(host, asyncFn) {
  if (!host) return;
  host.replaceChildren(makeSkeleton(3));
  const ctrl = new AbortController();
  const obs = new MutationObserver(() => {
    if (!host.isConnected) {
      ctrl.abort();
      obs.disconnect();
    }
  });
  if (host.parentNode) obs.observe(host.parentNode, { childList: true, subtree: true });
  try {
    await asyncFn(ctrl.signal, host);
  } catch (err) {
    if (ctrl.signal.aborted) return;
    renderAiError(host, err);
  } finally {
    obs.disconnect();
  }
}

export function renderAiError(host, err) {
  host.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'ai-error';
  const msg = document.createElement('span');
  msg.textContent = aiErrorText(err);
  wrap.append(msg);
  host.append(wrap);
}

/**
 * The localized text for an AI error whose code is known (no key, a rejected
 * key, rate limits, a refusal ...), or null for any other failure, whose own
 * message the caller keeps.
 */
export function knownAiErrorText(err) {
  const text = aiErrorText(err);
  return text === t('ai.error.generic') ? null : text;
}

export function aiErrorText(err) {
  const code = err && err.code;
  if (code === 'ai_disabled') return t('ai.error.disabled');
  if (code === 'no_user_api_key') return t('ai.error.noUserApiKey');
  if (code === 'invalid_user_api_key') return t('ai.error.invalidUserApiKey');
  if (code === 'rate_limited' || code === 'upstream_rate_limited') return t('ai.error.rateLimited');
  if (code === 'upstream_unavailable' || code === 'upstream_bad_request') return t('ai.error.unavailable');
  if (code === 'ai_bad_response') return t('ai.error.badResponse');
  if (code === 'ai_refused') return t('ai.error.refused');
  return t('ai.error.generic');
}
