import { describe, it, expect, vi } from 'vitest';
import { makeCompressedZipBlob, readZipEntries, makeZipBlob } from '../js/ui/zip.js';
import { readBudgetFile } from '../js/ui/read-budget-file.js';
import { buildExportEntries } from '../js/state/build-export-entries.js';
import { initialHistory } from '../js/core/financial-history.js';
const budget = () => ({ accounts: [{ id: 'bank', name: 'Bank', type: 'bank' }], envelopes: [], transactions: [],
  budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8, name: 'Export' } });
describe('compressed self-contained exports', () => {
  it('writes actual DEFLATE entries and round-trips all collections and history', async () => {
    const data = budget();
    data.meta.financialHistory = initialHistory(data, new Date('2026-10-08T12:00:00Z'));
    data.meta.notes = 'A budget with repeated words. '.repeat(1000);
    const entries = buildExportEntries(data);
    const compressed = await makeCompressedZipBlob(entries);
    expect(compressed.size).toBeLessThan(makeZipBlob(entries).size / 4);
    expect(await readZipEntries(new Uint8Array(await compressed.arrayBuffer()))).toEqual(entries);
    const loaded = await readBudgetFile(compressed);
    expect(loaded.ok).toBe(true);
    expect(loaded.bundle).toEqual(data);
  });
  it('imports a single JSON bundle in a ZIP and ignores macOS metadata', async () => {
    const data = budget();
    const zip = await makeCompressedZipBlob([{ name: 'budget.json', data: JSON.stringify(data) }, { name: '__MACOSX/._budget.json', data: 'metadata' }]);
    expect((await readBudgetFile(zip)).bundle).toEqual(data);
  });
  it('falls back to a valid stored ZIP when streaming compression is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const zip = await makeCompressedZipBlob(buildExportEntries(budget()));
      expect((await readBudgetFile(zip)).ok).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects ambiguous single-bundle ZIPs rather than choosing arbitrary data', async () => {
    const zip = await makeCompressedZipBlob(['one.json','two.json'].map(name => ({ name, data: JSON.stringify(budget()) })));
    expect((await readBudgetFile(zip)).ok).toBe(false);
  });
  it('accepts a whole folder archive but refuses a manifest without its history', async () => {
    const { packHistoryMeta } = await import('../js/storage/history-chunks.js');
    const data = budget(); data.meta.financialHistory = initialHistory(data, new Date('2026-10-08T12:00:00Z'));
    const packed = await packHistoryMeta(data.meta);
    const entries = buildExportEntries(data).map(e => e.name === 'budget-meta.json' ? { ...e, data: JSON.stringify(packed.meta) } : e);
    expect((await readBudgetFile(await makeCompressedZipBlob(entries))).ok).toBe(false);
    entries.push(...packed.chunks.map(c => ({ name: `.bunvelope-history-${c.id}.json`, data: JSON.stringify(c.data) })));
    const restored = await readBudgetFile(await makeCompressedZipBlob(entries));
    expect(restored.ok).toBe(true);
    expect(restored.bundle.meta).toEqual(data.meta);
  });

});
