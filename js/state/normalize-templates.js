// js/state/normalize-templates.js — load-time shape coercion for envelope
// templates. Pure: no DOM, no I/O, so it can be exercised directly.
//
// Split out of load-budget.js, which reaches app.js and therefore the DOM.

const SCHEDULE_DAY_TYPES = new Set(['exact', 'next_work_day', 'prev_work_day']);
const MONTH_KEYS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Coerce a template's `schedule` into a shape the occurrence walker can trust,
 * or return undefined to drop it. A self-scheduled template posts real fills,
 * so a half-formed schedule from a hand-edited JSON file must not reach the
 * walker — dropping it means the template simply doesn't fire, which is the
 * safe failure.
 *
 * Month values are coerced to `true`: a template's amounts come from its lines,
 * so unlike a budget item's `monthly_schedule` there is nothing per-month to
 * override, and a stray number would otherwise read as an amount that is never
 * used.
 */
export function normalizeTemplateSchedule(sched) {
  if (!sched || typeof sched !== 'object') return undefined;
  const payDay = Number(sched.payment_day);
  if (!Number.isFinite(payDay) || payDay < 1 || payDay > 31) return undefined;
  if (!sched.months || typeof sched.months !== 'object') return undefined;

  const months = {};
  for (const k of MONTH_KEYS) {
    const v = sched.months[k];
    if (v !== undefined && v !== false) months[k] = true;
  }
  if (Object.keys(months).length === 0) return undefined;

  const out = {
    enabled: sched.enabled === true,
    payment_day: Math.floor(payDay),
    day_type: SCHEDULE_DAY_TYPES.has(sched.day_type) ? sched.day_type : 'exact',
    months,
  };
  if (typeof sched.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.since)) {
    out.since = sched.since;
  }
  if (typeof sched.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.until)) {
    out.until = sched.until;
  }
  // Source-envelope funding (see engine/scheduling.js templateFillSourceId):
  // written by external tooling, not (yet) by the template editor. Dropping it
  // here would silently revert a buffer-funded fill to an unallocated-funded
  // one on the next load — money-moving, so these keys must round-trip.
  if (typeof sched.source_envelope_id === 'string' && sched.source_envelope_id) {
    out.source_envelope_id = sched.source_envelope_id;
    if (typeof sched.source_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.source_since)) {
      out.source_since = sched.source_since;
    }
  }
  const skipped = (Array.isArray(sched.skipped) ? sched.skipped : [])
    .filter(k => typeof k === 'string' && /^\d{4}-\d{2}$/.test(k));
  if (skipped.length) out.skipped = skipped;
  return out;
}

/**
 * Fill in defaults for the `kind` field, ensure the matching sibling array
 * exists, and normalise any `schedule` block. Absence of `kind` means the
 * template was saved before dynamic templates landed — treat as manual.
 */
export function normalizeTemplates(templates) {
  if (!Array.isArray(templates)) return [];
  return templates.map((tpl) => {
    if (!tpl || typeof tpl !== 'object') return tpl;
    const kind = tpl.kind === 'dynamic' ? 'dynamic' : 'manual';
    const schedule = normalizeTemplateSchedule(tpl.schedule);
    let base = tpl;
    if (schedule) {
      base = { ...tpl, schedule };
    } else if ('schedule' in tpl) {
      base = { ...tpl };
      delete base.schedule;
    }
    if (kind === 'dynamic') {
      return {
        ...base,
        kind,
        assignments: Array.isArray(tpl.assignments) ? tpl.assignments : [],
      };
    }
    return {
      ...base,
      kind,
      lines: Array.isArray(tpl.lines) ? tpl.lines : [],
    };
  });
}
