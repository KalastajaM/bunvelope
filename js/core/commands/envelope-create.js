import { assignShortCode } from '../short-codes.js';
// envelope.create — a new envelope. The id is made from the category and name
// as the form makes it, the name must be unique, and the fields are stored as
// the form stores them (applyEnvelopeFields). spend_flag_exempt is always
// written, so the legacy category-name fallback stops applying to it.

import { ok, fail } from '../result.js';
import {
  ENVELOPE_FIELD_PROPERTIES, checkForecastShares, applyEnvelopeFields, checkName, newEnvelopeId, trimEnvelopeText,
} from '../entity-fields.js';

export default {
  name: 'envelope.create',
  summary: 'Create an envelope. The id is made from the category and name; the name must be unique (case-insensitive, archived envelopes included). A goal needs both goal_amount and goal_date to take effect.',
  input: {
    type: 'object',
    required: ['name'],
    properties: {
      ...ENVELOPE_FIELD_PROPERTIES,
      spend_flag_exempt: { ...ENVELOPE_FIELD_PROPERTIES.spend_flag_exempt, default: false },
    },
  },
  execute(data, input, ctx) {
    const codeResult = assignShortCode(data, 'envelope', trimEnvelopeText(input));
    if (!codeResult.ok) return codeResult;
    const fields = codeResult.value;
    const invalidShares = checkForecastShares(fields, data.accounts || []);
    if (invalidShares) return fail('bad_input', { errors: [invalidShares] });
    const bad = checkName('envelope', data.envelopes, fields.name);
    if (bad) return fail(bad.code, bad.params);
    const category = fields.category ?? '';
    const id = newEnvelopeId(data.envelopes, category, fields.name);
    const envelope = applyEnvelopeFields(
      { id, name: fields.name, category, description: fields.description ?? '', archived: false },
      fields,
      ctx.todayIso,
    );
    return ok({ changes: { envelopes: [...data.envelopes, envelope] }, value: { id } });
  },
};
