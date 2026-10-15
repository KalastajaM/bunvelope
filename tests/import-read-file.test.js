import { describe, it, expect } from 'vitest';
import { readImportFile } from '../js/import/read-file.js';

function fileFromBytes(bytes) {
  // Minimal File-like stub: only `arrayBuffer()` is consumed by readImportFile.
  return {
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe('readImportFile', () => {
  it('decodes UTF-8 input correctly', async () => {
    const utf8 = new TextEncoder().encode('TYÖELÄKEYHTIÖ ELO');
    const text = await readImportFile(fileFromBytes(utf8));
    expect(text).toBe('TYÖELÄKEYHTIÖ ELO');
  });

  it('falls back to Windows-1252 for ä/ö in legacy bank exports', async () => {
    // Same string encoded as Windows-1252: ä=0xE4, ö=0xF6, Ö=0xD6, Ä=0xC4
    const w1252 = new Uint8Array([
      0x54, 0x59, 0xD6, 0x45, 0x4C, 0xC4, 0x4B, 0x45, 0x59, 0x48, 0x54, 0x49, 0xD6,
      0x20, 0x45, 0x4C, 0x4F,
    ]);
    const text = await readImportFile(fileFromBytes(w1252));
    expect(text).toBe('TYÖELÄKEYHTIÖ ELO');
  });

  it('strips UTF-8 BOM', async () => {
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const body = new TextEncoder().encode('a;b;c');
    const merged = new Uint8Array(bom.length + body.length);
    merged.set(bom, 0); merged.set(body, bom.length);
    const text = await readImportFile(fileFromBytes(merged));
    expect(text).toBe('a;b;c');
  });
});
