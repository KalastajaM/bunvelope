// Codes share one namespace across accounts and envelopes, archived rows included.
import { ok, fail } from './result.js';

/** @param {any} data @param {string} kind @param {any} fields @param {any} existing */
export function assignShortCode(data, kind, fields, existing = null) {
  if (existing && !Object.hasOwn(fields, 'code')) return ok(fields);
  const rows = [...(data.accounts || []).filter(row => kind !== 'account' || row.id !== existing?.id),
    ...(data.envelopes || []).filter(row => kind !== 'envelope' || row.id !== existing?.id)];
  const taken = new Set(rows.map(row => String(row.code || '').trim().toUpperCase()).filter(Boolean));
  let code = String(fields.code ?? existing?.code ?? '').trim().toUpperCase();
  if (code) {
    if (!/^[A-Z0-9]{4}$/.test(code)) return fail('code_invalid');
    if (taken.has(code)) return fail('code_taken', { code });
  } else {
    const source = fields.category || existing?.category || fields.name || existing?.name || kind;
    const prefix = String(source).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2).padEnd(2, 'X');
    for (let n = 1; n < 100; n++) {
      const candidate = prefix + String(n).padStart(2, '0');
      if (!taken.has(candidate)) { code = candidate; break; }
    }
    // Keep four characters even after a prefix has used every decimal suffix.
    if (!code) for (let n = 0; n < 36 ** 4; n++) {
      const candidate = n.toString(36).toUpperCase().padStart(4, '0');
      if (!taken.has(candidate)) { code = candidate; break; }
    }
    if (!code) return fail('code_exhausted');
  }
  return ok({ ...fields, code });
}
