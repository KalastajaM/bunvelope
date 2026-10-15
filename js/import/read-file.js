// js/import/read-file.js
// Read a CSV/text file with tolerant encoding detection. Many Finnish bank
// exports (Nordea, OP, Danske) ship Windows-1252 / ISO-8859-1, which causes
// the default UTF-8 decoder to emit U+FFFD for ä/ö/å. Try strict UTF-8
// first; fall back to Windows-1252 when that fails.

export async function readImportFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}
