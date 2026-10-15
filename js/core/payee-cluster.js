// Pure payee comparison shared by cleanup discovery.
const LEGAL_SUFFIX = /\s(oyj|oy|ab|ltd|inc|bv|gmbh|as|asa)$/;

/** Fold a name for comparison: accents, case, punctuation, spacing. */
export function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Folded name minus trailing store/terminal numbers and legal-form suffixes. */
export function payeeClusterKey(payee) {
  const base = fold(payee);
  let k = base;
  for (let prev = ''; prev !== k;) {
    prev = k;
    k = k.replace(/(\s\d+)+$/, '').replace(LEGAL_SUFFIX, '').trim();
  }
  return k;
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Sørensen–Dice over character bigrams, spaces removed: 0..1. */
function dice(a, b) {
  const x = a.replace(/ /g, '');
  const y = b.replace(/ /g, '');
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) || 0);
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

/**
 * Whether two payee texts plausibly name the same payee. Both are reduced to
 * their cluster key (accents, case, punctuation, trailing store numbers and
 * legal-form suffixes folded away); they match when the keys are equal, when
 * the shorter key (three characters or more) is a whole-word part of the
 * longer one ("Lidl" and "LIDL HELSINKI KESKUSTA"), or when their character
 * bigrams overlap by at least 80 % (a typo, a squashed space). An empty payee
 * matches nothing.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function payeesSimilar(a, b) {
  const ka = payeeClusterKey(a);
  const kb = payeeClusterKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 3 && ` ${long} `.includes(` ${short} `)) return true;
  return dice(ka, kb) >= 0.8;
}
