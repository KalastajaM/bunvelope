// js/ui/passphrase-prompt.js — modal flows for client-side encryption.
// Three modes:
//   unlock  — single passphrase entry, used after login
//   setup   — new + confirm, with a hard-loss warning
//   change  — old + new + confirm (old validated against existing verifier)
//
// Each returns a Promise that resolves with the captured value(s) or null
// if the user cancels.

import { openSheet } from './sheet.js';
import { t } from './i18n.js';

const MIN_LEN = 10;

function field(labelText, { type = 'password', autofocus = false } = {}) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:block;margin-bottom:12px;';
  const lab = document.createElement('div');
  lab.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:4px;';
  lab.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'form-input';
  input.autocomplete = 'new-password';
  if (autofocus) setTimeout(() => input.focus(), 0);
  wrap.append(lab, input);
  return { wrap, input };
}

function errorLine() {
  const el = document.createElement('div');
  el.style.cssText = 'font-size:12px;color:var(--danger-text);min-height:18px;margin-top:4px;';
  return el;
}

function buttons({ okLabel, onOk, onCancel, danger = false }) {
  const row = document.createElement('div');
  row.dataset.sheetActions = '';
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost';
  cancel.textContent = t('security.cancel');
  cancel.addEventListener('click', onCancel);
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn-accent';
  if (danger) ok.style.background = 'var(--danger)';
  ok.textContent = okLabel;
  ok.addEventListener('click', onOk);
  row.append(cancel, ok);
  return { row, ok };
}

export function promptUnlock() {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    const intro = document.createElement('p');
    intro.style.cssText = 'font-size:14px;margin:0 0 14px;line-height:1.4;';
    intro.textContent = t('security.unlock.intro');
    const { wrap, input } = field(t('security.passphrase'), { autofocus: true });
    const err = errorLine();
    content.append(intro, wrap, err);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; close(); resolve(v); };
    const { row } = buttons({
      okLabel: t('security.unlock.submit'),
      onOk: () => {
        const v = input.value;
        if (!v) { err.textContent = t('security.err.empty'); return; }
        done(v);
      },
      onCancel: () => done(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.btn-accent').click(); }
    });
    content.append(row);
    const { close } = openSheet({
      title: t('security.unlock.title'),
      content,
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

export function promptSetup() {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    const warn = document.createElement('div');
    warn.style.cssText = 'background:color-mix(in srgb, var(--danger) 12%, transparent);'
      + 'border:1px solid var(--danger);padding:10px 12px;border-radius:8px;'
      + 'font-size:13px;line-height:1.45;margin-bottom:16px;';
    warn.textContent = t('security.setup.warning');
    // What enabling does beyond this budget, said before the passphrase is
    // typed: it converts every budget of the account, it is asked at each
    // sign-in, and the headless CLI refuses encrypted budgets.
    const facts = document.createElement('ul');
    facts.className = 'security-setup-facts';
    facts.style.cssText = 'margin:0 0 12px;padding-left:18px;font-size:13px;line-height:1.45;';
    for (const key of ['factAllBudgets', 'factEachSignIn', 'factCli']) {
      const li = document.createElement('li');
      li.textContent = t(`security.setup.${key}`);
      facts.append(li);
    }
    const { wrap: w1, input: pw1 } = field(t('security.newPassphrase'), { autofocus: true });
    const { wrap: w2, input: pw2 } = field(t('security.confirmPassphrase'));
    const err = errorLine();
    content.append(facts, warn, w1, w2, err);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; close(); resolve(v); };
    const { row } = buttons({
      okLabel: t('security.setup.submit'),
      onOk: () => {
        if (pw1.value.length < MIN_LEN) {
          err.textContent = t('security.err.tooShort')(MIN_LEN);
          return;
        }
        if (pw1.value !== pw2.value) {
          err.textContent = t('security.err.mismatch');
          return;
        }
        done(pw1.value);
      },
      onCancel: () => done(null),
    });
    [pw1, pw2].forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.btn-accent').click(); }
    }));
    content.append(row);
    const { close } = openSheet({
      title: t('security.setup.title'),
      content,
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

export function promptChange() {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    const { wrap: w0, input: oldPw } = field(t('security.currentPassphrase'), { autofocus: true });
    const { wrap: w1, input: pw1 } = field(t('security.newPassphrase'));
    const { wrap: w2, input: pw2 } = field(t('security.confirmPassphrase'));
    const err = errorLine();
    content.append(w0, w1, w2, err);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; close(); resolve(v); };
    const { row } = buttons({
      okLabel: t('security.change.submit'),
      onOk: () => {
        if (!oldPw.value) { err.textContent = t('security.err.empty'); return; }
        if (pw1.value.length < MIN_LEN) {
          err.textContent = t('security.err.tooShort')(MIN_LEN);
          return;
        }
        if (pw1.value !== pw2.value) {
          err.textContent = t('security.err.mismatch');
          return;
        }
        done({ oldPassphrase: oldPw.value, newPassphrase: pw1.value });
      },
      onCancel: () => done(null),
    });
    [oldPw, pw1, pw2].forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.btn-accent').click(); }
    }));
    content.append(row);
    const { close } = openSheet({
      title: t('security.change.title'),
      content,
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}
