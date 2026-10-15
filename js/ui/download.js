import { makeCompressedZipBlob } from './zip.js';
import { buildExportEntries } from '../state/build-export-entries.js';

// js/ui/download.js — tiny Blob-download helpers used by cloud-picker's
// Export button and Settings → Data → Export budget as ZIP.

export function sanitiseFilename(s) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned || 'untitled';
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)],
    { type: 'application/json' });
  downloadBlob(filename, blob);
}

export async function downloadBudgetZip(filename, bundle) {
  downloadBlob(filename, await makeCompressedZipBlob(buildExportEntries(bundle)));
}
