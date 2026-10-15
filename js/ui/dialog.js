// js/ui/dialog.js — in-app replacements for window.confirm / window.alert.
// Title/label defaults are evaluated per call, so they follow the live locale.
import { openSheet } from './sheet.js';
import { t } from './i18n.js';

function buttonRow({ danger, okLabel, cancelLabel, dismissLabel, onOk, onCancel, onDismiss }) {
  const row = document.createElement('div');
  row.dataset.sheetActions = '';
  row.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:20px;';
  if (onDismiss) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-ghost';
    dismiss.textContent = dismissLabel;
    dismiss.addEventListener('click', onDismiss);
    row.append(dismiss);
  }
  if (onCancel) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = cancelLabel;
    cancel.addEventListener('click', onCancel);
    row.append(cancel);
  }
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn-accent';
  if (danger) ok.style.background = 'var(--danger)';
  ok.textContent = okLabel;
  ok.addEventListener('click', onOk);
  row.append(ok);
  return row;
}

function messageBody(message) {
  const p = document.createElement('p');
  p.style.cssText = 'font-size:14px;line-height:1.5;color:var(--ink);white-space:pre-wrap;';
  p.textContent = message;
  return p;
}

export function confirmDialog(message, { title = t('dialog.confirmTitle'), okLabel = t('common.ok'), cancelLabel = t('common.cancel'), dismissLabel = null, danger = false } = {}) {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    let settled = false;
    const dismissValue = dismissLabel ? null : false;
    const done = (v) => { if (settled) return; settled = true; close(); resolve(v); };
    content.append(messageBody(message));
    content.append(buttonRow({
      danger, okLabel, cancelLabel, dismissLabel,
      onOk: () => done(true),
      onCancel: () => done(false),
      onDismiss: dismissLabel ? () => done(null) : null,
    }));
    const { close } = openSheet({ title, content, onClose: () => { if (!settled) resolve(dismissValue); } });
  });
}

export function alertDialog(message, { title = t('dialog.noticeTitle'), okLabel = t('common.ok') } = {}) {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    let settled = false;
    const done = () => { if (settled) return; settled = true; close(); resolve(); };
    content.append(messageBody(message));
    content.append(buttonRow({ okLabel, onOk: done }));
    const { close } = openSheet({ title, content, onClose: () => { if (!settled) resolve(); } });
  });
}

export function promptDialog(message, {
  title = t('dialog.enterValueTitle'),
  defaultValue = '',
  okLabel = t('common.ok'),
  cancelLabel = t('common.cancel'),
  placeholder = '',
  inputType = 'text',
} = {}) {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; close(); resolve(v); };
    if (message) content.append(messageBody(message));

    const input = document.createElement('input');
    input.type = inputType;
    input.className = 'form-input';
    input.value = defaultValue;
    if (placeholder) input.placeholder = placeholder;
    input.style.marginTop = '12px';
    content.append(input);

    const submit = () => done(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    content.append(buttonRow({
      okLabel, cancelLabel,
      onOk: submit,
      onCancel: () => done(null),
    }));

    const { close } = openSheet({ title, content, onClose: () => { if (!settled) resolve(null); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
