// tests/export-zip.test.js — store-only ZIP writer.
import { describe, it, expect } from 'vitest';
import { crc32, makeZipBlob } from '../js/ui/zip.js';

describe('crc32', () => {
  it('matches the standard vector for "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes) >>> 0).toBe(0xCBF43926);
  });

  it('returns 0 for an empty buffer', () => {
    expect(crc32(new Uint8Array()) >>> 0).toBe(0);
  });
});

// Helper: parse a store-only ZIP Blob back to { [name]: string }.
// Reads EOCD → central directory → each local file header. Only
// handles compressionMethod=0 (store) since that's all makeZipBlob writes.
async function parseStoreZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Find EOCD (End of Central Directory Record) — signature 0x06054b50.
  // Scan backward from end; it's within the last 22 + 0xFFFF bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');

  const entryCount   = dv.getUint16(eocd + 10, true);
  const cdSize       = dv.getUint32(eocd + 12, true);
  const cdOffset     = dv.getUint32(eocd + 16, true);

  const out = {};
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    // Central directory record: signature 0x02014b50.
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad CD sig');
    const compMethod = dv.getUint16(p + 10, true);
    const compSize   = dv.getUint32(p + 20, true);
    const nameLen    = dv.getUint16(p + 28, true);
    const extraLen   = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localHdrOff = dv.getUint32(p + 42, true);
    if (compMethod !== 0) throw new Error('only store method supported');

    // Local file header: signature 0x04034b50.
    const lh = localHdrOff;
    if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error('bad LH sig');
    const lhNameLen  = dv.getUint16(lh + 26, true);
    const lhExtraLen = dv.getUint16(lh + 28, true);
    const dataOff    = lh + 30 + lhNameLen + lhExtraLen;

    const nameBytes = buf.slice(p + 46, p + 46 + nameLen);
    const dataBytes = buf.slice(dataOff, dataOff + compSize);
    const name = new TextDecoder().decode(nameBytes);
    out[name] = new TextDecoder().decode(dataBytes);

    p += 46 + nameLen + extraLen + commentLen;
    void cdSize;
  }
  return out;
}

describe('makeZipBlob', () => {
  it('round-trips two entries with ASCII and non-ASCII content', async () => {
    const entries = [
      { name: 'a.txt', data: 'hello' },
      { name: 'b.json', data: JSON.stringify({ msg: 'héllo — wörld' }) },
    ];
    const blob = makeZipBlob(entries);
    expect(blob.type).toBe('application/zip');

    const parsed = await parseStoreZip(blob);
    expect(Object.keys(parsed).sort()).toEqual(['a.txt', 'b.json']);
    expect(parsed['a.txt']).toBe('hello');
    expect(parsed['b.json']).toBe(entries[1].data);
  });

  it('produces a valid EOCD with the correct entry count', async () => {
    const blob = makeZipBlob([
      { name: 'x', data: '1' },
      { name: 'y', data: '2' },
      { name: 'z', data: '3' },
    ]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    // EOCD for a zip with no comment is the last 22 bytes.
    const eocd = buf.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(3);
  });
});

import { buildExportEntries } from '../js/state/build-export-entries.js';

describe('buildExportEntries', () => {
  const sampleState = () => ({
    envelopes:         [{ id: 'e1', name: 'Food', category: 'Basics' }],
    budgetItems:       [{ id: 'i1', envelope_id: 'e1' }],
    transactions:      [
      { id: 't1', type: 'income',  date: '2026-04-01', amount: 1000, account: 'a1' },
      { id: 't2', type: 'expense', date: '2026-04-02', amount: 25,   account: 'a1' },
    ],
    accounts:          [{ id: 'a1', name: 'Main', initialBalance: 0 }],
    envelopeTemplates: [],
    meta:              { name: 'My Budget', currency: 'EUR' }, // no schemaVersion
  });

  it('produces six entries matching the on-disk filenames', () => {
    const entries = buildExportEntries(sampleState());
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual([
      'accounts.json',
      'budget-items.json',
      'budget-meta.json',
      'envelope-templates.json',
      'envelopes.json',
      'transactions.json',
    ]);
  });

  it('ensures schemaVersion is set on budget-meta.json even when source omits it', () => {
    const entries = buildExportEntries(sampleState());
    const meta = JSON.parse(entries.find(e => e.name === 'budget-meta.json').data);
    expect(meta.schemaVersion).toBe(8);
    expect(meta.name).toBe('My Budget');
  });

  // §3.1 — meta.ai holds AI consent state: whether AI is enabled, which
  // features were consented to, the consent version and per-feature
  // dismissals. Exporting it carried the exporter's consent to whoever
  // imported the budget, and the consent-version gate that would otherwise
  // re-prompt them was satisfied by someone else's answer.
  it('never exports AI consent state', () => {
    const st = sampleState();
    st.meta.ai = {
      enabled: true,
      consentVersion: 3,
      dismissed: true,
      perFeature: { chat: true },
      dismissedSubs: ['insights'],
    };
    const entries = buildExportEntries(st);
    const meta = JSON.parse(entries.find(e => e.name === 'budget-meta.json').data);
    expect(meta.ai).toBeUndefined();
    // Everything else in meta still travels.
    expect(meta.name).toBe('My Budget');
    expect(meta.currency).toBe('EUR');
    expect(meta.schemaVersion).toBe(8);
    // And the source state is not mutated.
    expect(st.meta.ai.enabled).toBe(true);
  });

  it('treats missing collections as empty arrays', () => {
    const entries = buildExportEntries({ meta: {} });
    const get = n => JSON.parse(entries.find(e => e.name === n).data);
    expect(get('envelopes.json')).toEqual([]);
    expect(get('budget-items.json')).toEqual([]);
    expect(get('transactions.json')).toEqual([]);
    expect(get('accounts.json')).toEqual([]);
    expect(get('envelope-templates.json')).toEqual([]);
  });

  it('round-trips through makeZipBlob back to the original collections', async () => {
    const st = sampleState();
    const blob = makeZipBlob(buildExportEntries(st));
    const parsed = await parseStoreZip(blob);
    expect(JSON.parse(parsed['envelopes.json'])).toEqual(st.envelopes);
    expect(JSON.parse(parsed['budget-items.json'])).toEqual(st.budgetItems);
    expect(JSON.parse(parsed['transactions.json'])).toEqual(st.transactions);
    expect(JSON.parse(parsed['accounts.json'])).toEqual(st.accounts);
    expect(JSON.parse(parsed['envelope-templates.json'])).toEqual(st.envelopeTemplates);
    expect(JSON.parse(parsed['budget-meta.json']).name).toBe('My Budget');
  });
});
