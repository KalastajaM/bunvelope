import { backups } from '../state/backup-service.js';
import { t } from './i18n.js';

export function backupStatusText(status) {
  if (status.busy) return t('automaticBackup.working');
  const last = status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : t('automaticBackup.never');
  const summary = status.enabled
    ? `${status.destination} · ${t('automaticBackup.lastSaved')} ${last}`
    : t('automaticBackup.off');
  if (status.error) return `${summary} · ${t('automaticBackup.failed')} ${status.error}`;
  return status.overdue ? `${summary} · ${t('automaticBackup.overdue')}` : summary;
}

export function updateBackupIndicator(source, openSettings) {
  let button = document.getElementById('status-backups');
  if (!button) {
    const path = document.getElementById('status-path');
    if (!path) return;
    button = document.createElement('button');
    button.id = 'status-backups';
    button.className = 'btn btn-ghost btn-sm';
    path.before(button);
  }
  const status = source ? backups.status(source) : {};
  button.hidden = !source || source.__guest ||
    !(status.error || status.overdue);
  button.textContent = t('automaticBackup.attention');
  button.title = backupStatusText(status);
  button.onclick = openSettings;
  const panel = document.getElementById('automatic-backup-status');
  if (panel && source) panel.textContent = backupStatusText(status);
}
