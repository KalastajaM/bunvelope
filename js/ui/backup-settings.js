import { confirmDialog } from './dialog.js';
import { backups } from '../state/backup-service.js';
import { backupStatusText } from './backup-status.js';
import { t } from './i18n.js';

export function appendBackupSettings(container, source) {
  if (!source || source.__guest) return;
  const supported = typeof window.showDirectoryPicker === 'function';
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:560px;margin-top:16px';
  card.id = 'automatic-backups';
  const title = document.createElement('h3');
  title.textContent = t('automaticBackup.title');
  const titleWrap = document.createElement('div');
  titleWrap.className = 'card-title';
  titleWrap.append(title);
  const help = document.createElement('p');
  help.className = 'sub';
  help.style.cssText = 'font-size:13px;color:var(--muted);line-height:1.5';
  help.textContent = t('automaticBackup.help');
  const unavailable = document.createElement('p');
  unavailable.textContent = t('automaticBackup.unsupported');
  unavailable.hidden = supported;
  const policy = document.createElement('p');
  policy.className = 'sub';
  policy.style.cssText = help.style.cssText;
  policy.textContent = t('automaticBackup.policy');
  const status = document.createElement('p');
  status.id = 'automatic-backup-status';
  status.style.cssText = 'font-size:12px;color:var(--muted)';
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
  function button(key) {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.textContent = t(key);
    actions.append(b);
    return b;
  }
  const choose = button('automaticBackup.choose');
  const backup = button('automaticBackup.backupNow');
  const stop = button('automaticBackup.disable');
  let busy = false;
  function refresh() {
    const value = backups.status(source);
    status.textContent = backupStatusText(value);
    choose.disabled = !supported || busy || value.busy;
    backup.disabled = stop.disabled = busy || value.busy || !value.enabled;
  }
  async function action(fn) {
    busy = true;
    refresh();
    let error;
    try { await fn(); }
    catch (e) { if (e.name !== 'AbortError') error = e.message; }
    finally { busy = false; refresh(); }
    if (error) status.textContent = `${t('automaticBackup.failed')} ${error}`;
  }
  choose.onclick = () => action(async () => {
    // Picker must run in the original user gesture, before any IDB work.
    const destination = await window.showDirectoryPicker({ mode: 'readwrite', id: 'bunvelope-backups' });
    if (source.kind === 'cloud' &&
        !await confirmDialog(t('automaticBackup.plaintextConsent'))) return;
    await backups.configure(source, destination);
  });
  backup.onclick = () => action(() => backups.run(source, true));
  stop.onclick = () => action(() => backups.disable(source));
  card.append(titleWrap, help, unavailable, policy, status, actions);
  container.append(card);
  const changed = () => {
    if (!card.isConnected) { window.removeEventListener('bunvelope-backup-status', changed); return; }
    refresh();
  };
  window.addEventListener('bunvelope-backup-status', changed);
  void action(() => backups.read(source));
}
