import { assignShortCode } from '../short-codes.js';
// envelope.update — set an envelope's fields. A changed name must be unique
// (an unchanged one may stay a duplicate). Values are stored as the form
// stores them, and goal_start is stamped once, beside a goal amount and date.

import { ok, fail } from '../result.js';
import {
  ENVELOPE_FIELD_PROPERTIES, checkForecastShares, applyEnvelopeFields, checkName, trimEnvelopeText,
} from '../entity-fields.js';

const prefixed = (errors) => errors.map(e => ({ ...e, path: `fields.${e.path}` }));

export default {
  name: 'envelope.update',
  summary: 'Change an envelope\'s fields (null clears one). A changed name must be unique. A goal needs both goal_amount and goal_date; goal_start is stamped when the goal is first complete.',
  input: {
    type: 'object',
    required: ['id', 'fields'],
    properties: {
      id: { type: 'ref', kind: 'envelope' },
      fields: { type: 'object', properties: ENVELOPE_FIELD_PROPERTIES },
    },
  },
  execute(data, input, ctx) {
    const env = data.envelopes.find(e => e.id === input.id);
    const codeResult = assignShortCode(data, 'envelope', trimEnvelopeText(input.fields), env);
    if (!codeResult.ok) return codeResult;
    const fields = codeResult.value;
    const invalidShares = checkForecastShares(fields, data.accounts || []);
    if (invalidShares) return fail('bad_input', { errors: [{ ...invalidShares, path: `fields.${invalidShares.path}` }] });
    if (Object.hasOwn(fields, 'name') && fields.name !== String(env.name ?? '').trim()) {
      const bad = checkName('envelope', data.envelopes, fields.name, env.id);
      if (bad) return bad.code === 'bad_input' ? fail('bad_input', { errors: prefixed(bad.params.errors) }) : fail(bad.code, bad.params);
    }
    const envelope = applyEnvelopeFields(env, fields, ctx.todayIso);
    return ok({
      changes: { envelopes: data.envelopes.map(e => (e.id === env.id ? envelope : e)) },
      value: { id: env.id },
    });
  },
};
