// Presentation-only filter defaults and date controls.

/**
 * `s` when it is a real calendar day written YYYY-MM-DD, else ''. The page's
 * own date inputs only give those, but a filter from another page (the AI's
 * navigate) arrives unchecked, and a query refuses anything else.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function realIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? s : '';
}

/**
 * The Transactions page's starting filters from a `state.pendingFilter` left
 * by another page: an envelope id, "account:<id>", "month:YYYY-MM", or a
 * structured { search, envelope, account, type, dateFrom, dateTo } (Reports;
 * `search` is the payee click-through, and plain search text matches payee
 * or note). Anything it does not set stays at its default.
 */
export function pendingFilterFields(initialFilter) {
  const out = { search: '', envelope: '', account: '', type: 'all', dateFrom: '', dateTo: '' };
  if (typeof initialFilter === 'string') {
    if (initialFilter.startsWith('account:')) out.account = initialFilter.slice(8);
    else if (initialFilter.startsWith('month:')) {
      // month:YYYY-MM — filter transactions to that calendar month.
      const [y, m] = initialFilter.slice(6).split('-').map(Number);
      if (y && m) {
        const pad2 = (n) => String(n).padStart(2, '0');
        out.dateFrom = `${y}-${pad2(m)}-01`;
        const endDate = new Date(y, m, 0); // last day of month m
        out.dateTo = `${endDate.getFullYear()}-${pad2(endDate.getMonth() + 1)}-${pad2(endDate.getDate())}`;
      }
    } else out.envelope = initialFilter;
  } else if (initialFilter && typeof initialFilter === 'object') {
    if (initialFilter.search)   out.search   = String(initialFilter.search);
    if (initialFilter.envelope) out.envelope = initialFilter.envelope;
    if (initialFilter.account)  out.account  = initialFilter.account;
    if (initialFilter.type)     out.type     = initialFilter.type;
    if (initialFilter.dateFrom) out.dateFrom = initialFilter.dateFrom;
    if (initialFilter.dateTo)   out.dateTo   = initialFilter.dateTo;
  }
  return out;
}

/**
 * Where the Transactions list opens on first paint: the index of the first
 * date header on or before `todayKey` (YYYY-MM-DD), or -1 to stay at the top.
 *
 * The list runs newest first and includes scheduled and future-dated rows, so
 * its top can be years ahead. An account, envelope, type, status or flag
 * filter still leaves a chronological ledger, and it opens at today too; that
 * is how an account's or envelope's transactions are reached. A search or a
 * date range is a question the user asked, and its answer starts at the top.
 *
 * @param {Array<{kind: string, date?: string}>} items virtual-list items
 * @param {{search?: string, dateFrom?: string, dateTo?: string}} ui
 * @param {string} todayKey
 * @returns {number}
 */
export function openAtTodayIndex(items, ui, todayKey) {
  if (ui.search || ui.dateFrom || ui.dateTo) return -1;
  return items.findIndex(it => it.kind === 'header' && it.date <= todayKey);
}

/**
 * One string naming the list's filters: two repaints with the same key show
 * the same question, so the list keeps its scroll; a new key is a new
 * search or filter, and its answer starts at the top (a search used to keep
 * the old offset and open on rows years back).
 *
 * @param {{search?: string, envelope?: string, account?: string, type?: string,
 *   status?: string, flagged?: string, dateFrom?: string, dateTo?: string,
 *   showScheduled?: boolean}} ui
 * @returns {string}
 */
export function filterKey(ui) {
  return JSON.stringify([ui.search || '', ui.envelope || '', ui.account || '', ui.type || 'all',
    ui.status || 'all', ui.flagged || 'all', ui.dateFrom || '', ui.dateTo || '', !!ui.showScheduled]);
}

/**
 * Date-range presets for quick filtering.
 * Each preset returns { from, to } (or null fields for open-ended ranges).
 * Today is passed in so callers can override it for tests.
 */
export function datePreset(key, today = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  switch (key) {
    case 'last7': {
      const from = new Date(t); from.setDate(t.getDate() - 6);
      return { from: ymd(from), to: ymd(t) };
    }
    case 'last30': {
      const from = new Date(t); from.setDate(t.getDate() - 29);
      return { from: ymd(from), to: ymd(t) };
    }
    case 'thisMonth': {
      // The whole calendar month: the list holds booked and scheduled rows
      // dated later this month, and "this month" should show them too.
      const from = new Date(t.getFullYear(), t.getMonth(), 1);
      const to   = new Date(t.getFullYear(), t.getMonth() + 1, 0);
      return { from: ymd(from), to: ymd(to) };
    }
    case 'lastMonth': {
      const from = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const to   = new Date(t.getFullYear(), t.getMonth(), 0);
      return { from: ymd(from), to: ymd(to) };
    }
    case 'ytd': {
      const from = new Date(t.getFullYear(), 0, 1);
      return { from: ymd(from), to: ymd(t) };
    }
    default:
      return { from: '', to: '' };
  }
}
