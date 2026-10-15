// tests/budget-file-import.test.js — the budget picker's file import reads the
// Settings ZIP export as well as the JSON bundle (owner decision 5,
// 2026-10-05), and validates both the same way.
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { makeZipBlob, readZipEntries, looksLikeZip, crc32 } from '../js/ui/zip.js';
import { buildExportEntries, bundleFromExportEntries } from '../js/state/build-export-entries.js';
import { readBudgetFile } from '../js/ui/read-budget-file.js';

const sampleState = () => ({
  envelopes: [{ id: 'e1', name: 'Food', category: 'Basics' }],
  budgetItems: [],
  transactions: [
    { id: 't1', type: 'income', date: '2026-04-01', amount: 1000, account: 'a1' },
    { id: 't2', type: 'expense', date: '2026-04-02', amount: 25, account: 'a1', envelope_id: 'e1', payee: 'Kauppa — äö' },
  ],
  accounts: [{ id: 'a1', name: 'Main', type: 'bank', initialBalance: 0 }],
  envelopeTemplates: [],
  meta: { name: 'My Budget', currency: 'EUR', schemaVersion: 8, ai: { enabled: true } },
});
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

/** A ZIP of deflated entries, as an OS archiver writes, under a folder. */
function deflatedZip(files) {
  const enc = new TextEncoder();
  const parts = []; const central = []; let offset = 0;
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  for (const f of files) {
    const name = Buffer.from(enc.encode(f.name));
    const raw = f.data instanceof Uint8Array ? f.data : enc.encode(f.data);
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(raw.length), u16(name.length), u16(0), name, comp]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    parts.push(local); offset += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

describe('readZipEntries', () => {
  it('reads back what the Settings export writes', async () => {
    const entries = buildExportEntries(sampleState());
    const bytes = await bytesOf(makeZipBlob(entries));
    expect(looksLikeZip(bytes)).toBe(true);
    expect(await readZipEntries(bytes)).toEqual(entries);
  });

  it('inflates a re-zipped (deflated) archive', async () => {
    const entries = buildExportEntries(sampleState()).map(e => ({ name: `My budget/${e.name}`, data: e.data }));
    expect(await readZipEntries(deflatedZip(entries))).toEqual(entries);
  });

  it('refuses a damaged entry and what is not a ZIP', async () => {
    const bytes = await bytesOf(makeZipBlob([{ name: 'a.json', data: '[1,2,3]' }]));
    bytes[30 + 'a.json'.length + 1] ^= 0xff; // a byte of the stored data
    await expect(readZipEntries(bytes)).rejects.toThrow(/a\.json is damaged/);
    await expect(readZipEntries(new TextEncoder().encode('{"x":1}'))).rejects.toThrow(/not a ZIP/);
    expect(looksLikeZip(new TextEncoder().encode('{"x":1}'))).toBe(false);
  });
});

describe('bundleFromExportEntries', () => {
  it('maps the six files to the bundle, wherever they sit, ignoring other files', () => {
    const entries = [...buildExportEntries(sampleState()).map(e => ({ name: `export/${e.name}`, data: e.data })),
      { name: 'export/README.txt', data: 'hi' }, { name: '__MACOSX/export/._accounts.json', data: '\u0000' }];
    const r = bundleFromExportEntries(entries);
    expect(r.ok).toBe(true);
    expect(r.bundle.transactions).toEqual(sampleState().transactions);
    expect(r.bundle.meta.name).toBe('My Budget');
    // The export already left AI consent out.
    expect(r.bundle.meta.ai).toBeUndefined();
  });

  it('names a file that is not JSON, a file twice, and an archive with no budget in it', () => {
    expect(bundleFromExportEntries([{ name: 'accounts.json', data: '{' }]).errors[0]).toMatch(/accounts\.json is not valid JSON/);
    expect(bundleFromExportEntries([{ name: 'a/accounts.json', data: '[]' }, { name: 'b/accounts.json', data: '[]' }]).errors[0]).toMatch(/appears twice/);
    expect(bundleFromExportEntries([{ name: 'photo.jpg', data: 'x' }]).errors[0]).toMatch(/no budget files/);
  });
});

describe('readBudgetFile', () => {
  it('opens a Finder-compressed single JSON bundle and ignores binary metadata', async () => {
    const st = sampleState();
    const bytes = deflatedZip([
      { name: 'export/budget.json', data: JSON.stringify(st) },
      { name: '__MACOSX/export/._budget.json', data: new Uint8Array([0xff, 0xfe, 0, 1]) },
      { name: 'export/.DS_Store', data: new Uint8Array([0xff, 0xfe]) },
    ]);
    expect(await readBudgetFile(new Blob([bytes]))).toMatchObject({ ok: true, format: 'zip', bundle: st });
  });

  it('ignores binary resource forks in a six-file export too', async () => {
    const bytes = deflatedZip([...buildExportEntries(sampleState()),
      { name: 'nested/__MACOSX/._accounts.json', data: new Uint8Array([0xff]) }]);
    expect(await readBudgetFile(new Blob([bytes]))).toMatchObject({ ok: true, format: 'zip' });
  });

  it('refuses to choose between multiple bundles or mixed bundle/collection exports', async () => {
    const bundle = { name: 'budget.json', data: JSON.stringify(sampleState()) };
    for (const files of [[bundle, { ...bundle, name: 'other.json' }], [...buildExportEntries(sampleState()), bundle]]) {
      expect(await readBudgetFile(makeZipBlob(files))).toMatchObject({ ok: false, reason: 'notBundle', issue: 'ambiguous' });
    }
  });

  it('validates malformed and incomplete bundled JSON instead of treating it as a budget', async () => {
    for (const data of ['{', '{}', 'null']) {
      expect(await readBudgetFile(makeZipBlob([{ name: 'budget.json', data }]))).toMatchObject({ ok: false, reason: 'notBundle' });
    }
  });

  it('reads the Settings ZIP and the JSON bundle to the same bundle', async () => {
    const st = sampleState();
    const zip = await readBudgetFile(makeZipBlob(buildExportEntries(st)));
    const { ai: _ai, ...meta } = st.meta;
    const json = await readBudgetFile(new Blob([JSON.stringify({ ...st, meta })], { type: 'application/json' }));
    expect(zip).toMatchObject({ ok: true, format: 'zip' });
    expect(json).toMatchObject({ ok: true, format: 'json' });
    expect(zip.bundle).toEqual(json.bundle);
  });

  it('validates a ZIP as the JSON import does: a missing collection is named', async () => {
    const entries = buildExportEntries(sampleState()).filter(e => e.name !== 'accounts.json');
    const r = await readBudgetFile(makeZipBlob(entries));
    expect(r).toMatchObject({ ok: false, reason: 'notBundle', format: 'zip' });
    expect(r.errors).toContain('accounts missing');
    const bad = await readBudgetFile(makeZipBlob(buildExportEntries({ ...sampleState(), accounts: { a1: 'not a list' } })));
    expect(bad.ok).toBe(false);
  });

  it('says a file is unreadable when it is neither', async () => {
    expect(await readBudgetFile(new Blob(['not json']))).toMatchObject({ ok: false, reason: 'unreadable', format: 'json' });
  });
});
