import { createAutomaticBackup } from '../data.js';
import { createBackupController } from '../storage/automatic-backups.js';

export const backups = createBackupController({
  snapshot: createAutomaticBackup,
  changed: () => globalThis.dispatchEvent?.(new Event('bunvelope-backup-status')),
});
