// js/ui/tweaks.js
import { FEATURES, enabledFeatures, normalizeFeatures, requiredBy } from './features.js';
import { getPrefs, savePrefs, navigate, state } from '../app.js';
import { t, getLang, setLang, LOCALES, LOCALE_NAMES } from './i18n.js';
import { relabelShell } from './shell.js';
import { getThemePref, setThemePref } from './theme.js';
import { syncLensControls } from './lens-control.js';

/**
 * Switch between presets and custom optional views. The nav follows through applyPrefs;
 * the current page is redrawn because simple mode pins the balance view,
 * so its balances can change.
 */
export function setUiMode(mode) {
  const prefs = getPrefs();
  const patch = { uiMode: mode };
  if (mode === 'advanced' && !Array.isArray(prefs.uiFeatures)) patch.uiFeatures = enabledFeatures(prefs);
  savePrefs(patch);
  syncLensControls();
  const tw = document.getElementById('tweaks');
  if (tw) renderTweaks(tw);
  if (state.budgetFolder && state.currentPage) navigate(state.currentPage);
}

export function renderTweaks(host) {
  host.innerHTML = '';

  const h = document.createElement('h4');
  h.textContent = t('tweaks.title');
  host.append(h);

  host.append(seg(t('tweaks.mode'), [
    ['simple', t('tweaks.modeSimple')], ['full', t('tweaks.modeFull')], ['advanced', t('tweaks.modeAdvanced')]
  ], ['simple', 'advanced'].includes(getPrefs().uiMode) ? getPrefs().uiMode : 'full', setUiMode, t('tweaks.modeHint')));

  if (getPrefs().uiMode === 'advanced') host.append(featureChoices());

  host.append(seg(t('tweaks.language'),
    LOCALES.map(l => [l, LOCALE_NAMES[l]]),
    getLang(), (v) => { savePrefs({ lang: v }); setLang(v); relabelShell(); navigate(state.currentPage); refresh(); }));

  // Per browser (localStorage), not savePrefs: those sync to the account.
  host.append(seg(t('tweaks.theme'), [
    ['light', t('tweaks.themeLight')], ['dark', t('tweaks.themeDark')], ['system', t('tweaks.themeSystem')]
  ], getThemePref(), (v) => { setThemePref(v); }));

  host.append(seg(t('tweaks.navigation'), [
    ['rail', t('tweaks.rail')], ['top', t('tweaks.top')], ['hybrid', t('tweaks.hybrid')]
  ], getPrefs().nav, (v) => { savePrefs({ nav: v }); }));

  host.append(seg(t('tweaks.statusbar'), [
    ['top', t('tweaks.statusbarTop')], ['bottom', t('tweaks.statusbarBottom')]
  ], getPrefs().statusbarPosition === 'top' ? 'top' : 'bottom', (v) => { savePrefs({ statusbarPosition: v }); }));

  host.append(seg(t('tweaks.density'), [
    ['compact', t('tweaks.compact')], ['comfy', t('tweaks.comfy')], ['spacious', t('tweaks.spacious')]
  ], getPrefs().density, (v) => { savePrefs({ density: v }); }));

  host.append(swatches(t('tweaks.accent'), ['mint','peach','sky','lilac'], getPrefs().accent, (v) => { savePrefs({ accent: v }); }));

  function refresh() { renderTweaks(host); }
}

function featureChoices() {
  const box = document.createElement('div');
  box.className = 'feature-choices';
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = t('tweaks.featuresHint');
  box.append(hint);
  const selection = enabledFeatures(getPrefs());
  for (const feature of FEATURES) {
    const row = document.createElement('div');
    row.className = 'settings-toggle';
    const text = document.createElement('div');
    text.className = 'settings-toggle-text';
    const label = document.createElement('label');
    label.className = 'settings-toggle-label';
    label.htmlFor = `feature-${feature.id}`;
    label.textContent = t(feature.label);
    const description = document.createElement('span');
    description.id = `feature-hint-${feature.id}`;
    description.className = 'settings-toggle-hint';
    const dependents = requiredBy(selection, feature.id);
    description.textContent = t(`tweaks.features.${feature.id}`);
    if (dependents.length) description.textContent += ' ' + t('tweaks.requiredBy') + ' ' + dependents.map(f => t(f.label)).join(', ');
    text.append(label, description);
    const toggle = document.createElement('label');
    toggle.className = 'bp-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = label.htmlFor;
    input.checked = selection.includes(feature.id);
    input.disabled = dependents.length > 0;
    input.setAttribute('aria-describedby', description.id);
    input.addEventListener('change', () => {
      const next = input.checked ? [...selection, feature.id] : selection.filter(id => id !== feature.id);
      savePrefs({ uiFeatures: normalizeFeatures(next) });
      setUiMode('advanced');
      document.getElementById(input.id)?.focus();
    });
    const track = document.createElement('span');
    track.className = 'bp-switch-track';
    toggle.append(input, track);
    row.append(text, toggle);
    box.append(row);
  }
  return box;
}

function seg(label, options, current, onChange, title) {
  const row = rowEl(label);
  if (title) row.title = title;
  const seg = document.createElement('div'); seg.className = 'seg';
  options.forEach(([v, l]) => {
    const b = document.createElement('button');
    b.textContent = l;
    if (v === current) b.classList.add('on');
    b.setAttribute('aria-pressed', String(v === current));
    b.addEventListener('click', () => { onChange(v); seg.querySelectorAll('button').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); }); b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); });
    seg.append(b);
  });
  row.append(seg);
  return row;
}

function swatches(label, hues, current, onChange) {
  const row = rowEl(label);
  const wrap = document.createElement('div'); wrap.className = 'swatch-row';
  hues.forEach(h => {
    // A button with its colour's name, so the choice is labelled for a
    // screen reader and on hover, and reachable by keyboard.
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch' + (h === current ? ' on' : '');
    s.style.background = `var(--${h})`;
    const name = t(`tweaks.accent${h[0].toUpperCase()}${h.slice(1)}`);
    s.title = name;
    s.setAttribute('aria-label', name);
    s.setAttribute('aria-pressed', String(h === current));
    s.addEventListener('click', () => {
      onChange(h);
      wrap.querySelectorAll('.swatch').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      s.classList.add('on');
      s.setAttribute('aria-pressed', 'true');
    });
    wrap.append(s);
  });
  row.append(wrap);
  return row;
}

function rowEl(label) {
  const row = document.createElement('div'); row.className = 'tweak-row';
  const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
  row.append(l);
  return row;
}
