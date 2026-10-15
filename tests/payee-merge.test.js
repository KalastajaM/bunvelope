import { describe, it, expect } from 'vitest';
import {
  payeeClusterKey, listPayees, findPayeeClusters, searchPayees, mergePayees, mergePayeeRules,
  getIgnoredClusters, ignoreCluster, unignoreCluster, splitIgnoredClusters,
  findLooseClusters, looseKey, splitIgnoredLooseClusters, refreshBasket, hasProcessorPrefix, preferredTarget, FIRST_WORD_MAX,
} from '../js/state/payee-merge.js';

describe('payeeClusterKey', () => {
  it('folds case, accents, punctuation and whitespace', () => {
    expect(payeeClusterKey('K-Market  Kamppi')).toBe('k market kamppi');
    expect(payeeClusterKey('K-MARKET KAMPPI')).toBe('k market kamppi');
    expect(payeeClusterKey('Café Regatta')).toBe(payeeClusterKey('Cafe Regatta'));
  });
  it('drops trailing store numbers and legal-form suffixes', () => {
    expect(payeeClusterKey('LIDL 1234')).toBe('lidl');
    expect(payeeClusterKey('Elisa Oyj')).toBe('elisa');
    expect(payeeClusterKey('Telia Finland Oy 0042')).toBe('telia finland');
  });
  it('keeps a name that is only a number', () => {
    expect(payeeClusterKey('1234')).toBe('1234');
  });
});

describe('findPayeeClusters, symbol-only payees', () => {
  it('never clusters payees that fold to an empty key', () => {
    const symbolTxs = [
      { id: 's1', type: 'expense', payee: '-', date: '2026-01-01' },
      { id: 's2', type: 'expense', payee: '?', date: '2026-01-02' },
      { id: 's3', type: 'expense', payee: '—', date: '2026-01-03' },
    ];
    expect(symbolTxs.map(t => payeeClusterKey(t.payee))).toEqual(['', '', '']);
    expect(findPayeeClusters(listPayees(symbolTxs))).toEqual([]);
  });
});

const txs = [
  { id: '1', type: 'expense', payee: 'LIDL 1234', date: '2026-01-02' },
  { id: '2', type: 'expense', payee: 'Lidl', date: '2026-02-02' },
  { id: '3', type: 'expense', payee: 'lidl', date: '2026-03-02' },
  { id: '4', type: 'expense', payee: 'Elisa Oyj', date: '2026-01-05' },
  { id: '5', type: 'expense', payee: 'Elisa', date: '2026-02-05' },
  { id: '6', type: 'expense', payee: 'Unique Shop', date: '2026-01-09' },
  { id: '7', type: 'fill', payee: 'Fill envelopes', date: '2026-01-01' },
];

describe('listPayees', () => {
  it('counts rows per lower-cased name, newest casing wins, skips envelope-internal rows', () => {
    const out = listPayees(txs);
    expect(out.find(p => p.key === 'lidl')).toMatchObject({ payee: 'lidl', count: 2, lastDate: '2026-03-02' });
    expect(out.some(p => p.key === 'fill envelopes')).toBe(false);
    expect(out[0].count).toBeGreaterThanOrEqual(out[out.length - 1].count);
  });
});

describe('findPayeeClusters', () => {
  it('groups names that fold to the same key, biggest first, singletons left out', () => {
    const clusters = findPayeeClusters(listPayees(txs));
    expect(clusters.map(c => c.clusterKey)).toEqual(['lidl', 'elisa']);
    expect(clusters[0].members.map(m => m.key)).toEqual(['lidl', 'lidl 1234']);
    expect(clusters[0].total).toBe(3);
  });
});

describe('searchPayees', () => {
  it('matches on the folded name', () => {
    expect(searchPayees(listPayees(txs), 'LÍDL').map(p => p.key).sort()).toEqual(['lidl', 'lidl 1234']);
    expect(searchPayees(listPayees(txs), '')).toEqual([]);
  });

  it('also finds a spelling a typo away, after the substring matches', () => {
    const payees = ['Verkkokauppa', 'Verkkauppa Lamps', 'Moving: Verkkokauppa', 'Veikkaus'].map(n => ({ payee: n, key: n.toLowerCase(), count: 1, lastDate: '' }));
    expect(searchPayees(payees, 'verkkauppa').map(p => p.payee)).toEqual(['Verkkauppa Lamps', 'Verkkokauppa', 'Moving: Verkkokauppa']);
    expect(searchPayees(payees, 'Verkkokauppa').map(p => p.payee)).toEqual(['Verkkokauppa', 'Moving: Verkkokauppa', 'Verkkauppa Lamps']);
    // A short query matches as a substring only.
    expect(searchPayees(payees, 'veik').map(p => p.payee)).toEqual(['Veikkaus']);
  });
});

describe('mergePayees', () => {
  it('renames every row whose payee is in fromKeys and stamps modified_at', () => {
    const { transactions, changed } = mergePayees(txs, new Set(['lidl 1234', 'lidl']), 'Lidl', 'T');
    expect(changed).toBe(2);   // '2' already reads exactly 'Lidl'
    expect(transactions.filter(t => t.payee === 'Lidl').map(t => t.id)).toEqual(['1', '2', '3']);
    expect(transactions.find(t => t.id === '1').modified_at).toBe('T');
    expect(transactions.find(t => t.id === '2').modified_at).toBeUndefined();
    expect(txs[0].payee).toBe('LIDL 1234');   // input not mutated
  });
  it('never touches envelope-internal rows', () => {
    const { changed } = mergePayees(txs, new Set(['fill envelopes']), 'X', 'T');
    expect(changed).toBe(0);
  });
  it('returns the same array when nothing changes', () => {
    const r = mergePayees(txs, new Set(['nope']), 'X', 'T');
    expect(r.transactions).toBe(txs);
  });
});

describe('mergePayeeRules', () => {
  it('moves a symbol rule onto the target and drops the merged keys', () => {
    expect(mergePayeeRules({ 'nordnet 1': 'VWCE', other: 'X' }, new Set(['nordnet 1']), 'Nordnet'))
      .toEqual({ nordnet: 'VWCE', other: 'X' });
  });
  it('keeps the target’s own rule when it has one', () => {
    expect(mergePayeeRules({ 'nordnet 1': 'VWCE', nordnet: 'IWDA' }, new Set(['nordnet 1']), 'Nordnet'))
      .toEqual({ nordnet: 'IWDA' });
  });
});

describe('ignored suggestion groups', () => {
  const cluster = (clusterKey, ...keys) => ({ clusterKey, members: keys.map(key => ({ key, payee: key, count: 1 })), total: keys.length });

  it('ignoreCluster records the group with the spellings it has now', () => {
    const next = ignoreCluster({}, cluster('anna', 'anna', 'anna 2'));
    expect(next).toEqual({ anna: ['anna', 'anna 2'] });
  });

  it('splitIgnoredClusters hides an ignored group and lists it separately', () => {
    const a = cluster('anna', 'anna', 'anna 2');
    const b = cluster('lidl', 'lidl', 'lidl 1234');
    const { active, ignored } = splitIgnoredClusters([a, b], ignoreCluster({}, a));
    expect(active).toEqual([b]);
    expect(ignored).toEqual([a]);
  });

  it('brings a group back when a new spelling joins it', () => {
    const ignoredMap = ignoreCluster({}, cluster('anna', 'anna', 'anna 2'));
    const grown = cluster('anna', 'anna', 'anna 2', 'anna oy');
    expect(splitIgnoredClusters([grown], ignoredMap).active).toEqual([grown]);
  });

  it('stays ignored when a spelling disappears (merged away)', () => {
    const ignoredMap = ignoreCluster({}, cluster('anna', 'anna', 'anna 2', 'anna 3'));
    const shrunk = cluster('anna', 'anna', 'anna 2');
    expect(splitIgnoredClusters([shrunk], ignoredMap).ignored).toEqual([shrunk]);
  });

  it('unignoreCluster removes the entry and leaves the rest', () => {
    const m = { anna: ['anna', 'anna 2'], lidl: ['lidl', 'lidl 1'] };
    expect(unignoreCluster(m, 'anna')).toEqual({ lidl: ['lidl', 'lidl 1'] });
    expect(m.anna).toBeDefined(); // input untouched
  });

  it('getIgnoredClusters tolerates missing or malformed meta', () => {
    expect(getIgnoredClusters(undefined)).toEqual({});
    expect(getIgnoredClusters({ payeeMergeIgnored: 'x' })).toEqual({});
    expect(getIgnoredClusters({ payeeMergeIgnored: { a: ['a'], b: 'nope' } })).toEqual({ a: ['a'] });
  });
});

describe('looseKey / findLooseClusters', () => {
  const p = (payee, count = 1) => ({ payee, key: payee.toLowerCase(), count, lastDate: '' });
  const keysOf = groups => groups.map(g => g.members.map(m => m.payee).sort());

  it('strips card-processor prefixes before folding', () => {
    expect(looseKey('PAYPAL *STEAM')).toBe('steam');
    expect(looseKey('SQ *Joes Coffee')).toBe('joes coffee');
    expect(looseKey('SumUp  * Kahvila Kulma')).toBe('kahvila kulma');
    expect(looseKey('Lidl 1234')).toBe('lidl');
  });

  it('groups a processor spelling with the plain name', () => {
    expect(keysOf(findLooseClusters([p('PAYPAL *STEAM', 3), p('Steam', 5)]))).toEqual([['PAYPAL *STEAM', 'Steam']]);
  });

  it('groups by the same first meaningful word, not by stopwords or short words', () => {
    expect(keysOf(findLooseClusters([p('Albert Heijn 1234'), p('Albert Heijn Amsterdam'), p('The Bar'), p('The Pub'), p('Aldi Nord'), p('Aldi Süd')])))
      .toEqual([['Albert Heijn 1234', 'Albert Heijn Amsterdam'], ['Aldi Nord', 'Aldi Süd']]);
    expect(findLooseClusters([p('Bar One'), p('Bar Two')])).toEqual([]); // first word shorter than 4
  });

  it('suggests a near-identical spelling, also with notes after the name', () => {
    expect(keysOf(findLooseClusters([p('Verkkokauppa', 38), p('Verkkauppa', 5), p('Verkkokauppa lamps'), p('Verkkauppa Lamps')])))
      .toEqual([['Verkkauppa', 'Verkkauppa Lamps', 'Verkkokauppa', 'Verkkokauppa lamps']]);
  });

  it('a first word shared by many payees (a person, not a shop) does not make one big group', () => {
    const anna = ['Lunch', 'dentist', 'dress', 'Doctor', 'hairdresser', 'Massage', 'Earrings', 'Clothes', 'Agenda']
      .map(w => p(`Anna ${w}`));
    expect(anna.length).toBeGreaterThan(FIRST_WORD_MAX);
    expect(findLooseClusters(anna)).toEqual([]);
    // A typo still finds its partner among them.
    expect(keysOf(findLooseClusters([...anna, p('Anna Dentsit')]))).toEqual([['Anna Dentsit', 'Anna dentist']]);
    // A few branches of one shop still group by their first word.
    expect(keysOf(findLooseClusters([p('Aldi Nord'), p('Aldi Süd')]))).toEqual([['Aldi Nord', 'Aldi Süd']]);
  });

  it('names that differ only in a number are not typos of each other', () => {
    expect(findLooseClusters([p('HSL 2x'), p('HSL 3x'), p('Taxes 2019 1/2'), p('Taxes 2019 2/2')])).toEqual([]);
  });

  it('groups small typos in longer names only', () => {
    expect(keysOf(findLooseClusters([p('Spotify'), p('Spotfy'), p('Shell'), p('Shelly')]))).toEqual([['Spotfy', 'Spotify']]);
  });

  it('leaves exact-group members out of the loose pool entirely, even alongside a payee that would otherwise join them', () => {
    expect(findLooseClusters([p('LIDL 1234'), p('Lidl')])).toEqual([]);
    // 'LIDL 1234' and 'Lidl' share an exact clusterKey ('lidl'), so both are
    // removed from the loose pool before clustering; 'Lidl Plus' is then
    // alone and cannot form a loose group by itself — the group never
    // repeats what the exact rule already found.
    expect(findLooseClusters([p('LIDL 1234'), p('Lidl'), p('Lidl Plus')])).toEqual([]);
  });

  it('once the exact group is merged away, the kept single spelling rejoins the loose pool', () => {
    // Simulates the next render after 'LIDL 1234' + 'Lidl' were merged to
    // 'Lidl': only one spelling remains, so it is no longer an exact group
    // and is free to cluster loosely with 'Lidl Plus'.
    expect(keysOf(findLooseClusters([p('Lidl'), p('Lidl Plus')]))).toEqual([['Lidl', 'Lidl Plus']]);
  });

  it('keys groups for Ignore and orders by total rows', () => {
    const g = findLooseClusters([p('Spotify', 2), p('Spotfy', 1), p('PAYPAL *STEAM', 9), p('Steam', 9)]);
    expect(g[0].clusterKey).toMatch(/^loose:/);
    expect(g.map(x => x.total)).toEqual([18, 3]);
  });
});

describe('splitIgnoredLooseClusters', () => {
  const p = (payee, count = 1) => ({ payee, key: payee.toLowerCase(), count, lastDate: '' });

  it('stays ignored when a member merges away and the clusterKey (first current member) changes', () => {
    const group = findLooseClusters([p('Albert Heijn 1234'), p('Albert Heijn Amsterdam'), p('Albert Heijn Zuid')]);
    expect(group.length).toBe(1);
    const ignoredMap = ignoreCluster({}, group[0]);

    // One member ('Albert Heijn 1234', alphabetically first) is merged away;
    // the remaining two now yield a DIFFERENT clusterKey (loose:<first of
    // what's left>) from findLooseClusters, but membership-matching should
    // still recognise it as the same ignored group.
    const shrunk = findLooseClusters([p('Albert Heijn Amsterdam'), p('Albert Heijn Zuid')]);
    expect(shrunk.length).toBe(1);
    expect(shrunk[0].clusterKey).not.toBe(group[0].clusterKey);

    const { active, ignored } = splitIgnoredLooseClusters(shrunk, ignoredMap);
    expect(active).toEqual([]);
    expect(ignored).toEqual([{ ...shrunk[0], ignoredKeys: [group[0].clusterKey] }]);
  });

  it('brings the group back (active) when a new spelling joins it', () => {
    const group = findLooseClusters([p('Albert Heijn 1234'), p('Albert Heijn Amsterdam')]);
    const ignoredMap = ignoreCluster({}, group[0]);

    const grown = findLooseClusters([p('Albert Heijn 1234'), p('Albert Heijn Amsterdam'), p('Albert Heijn Noord')]);
    expect(grown.length).toBe(1);

    const { active, ignored } = splitIgnoredLooseClusters(grown, ignoredMap);
    expect(active).toEqual(grown);
    expect(ignored).toEqual([]);
  });

  it('attaches ignoredKeys (every stored key covering the shrunk group) so Restore can delete the right entry', () => {
    const group = findLooseClusters([p('Albert Heijn 1234'), p('Albert Heijn Amsterdam'), p('Albert Heijn Zuid')]);
    const ignoredMap = ignoreCluster({}, group[0]);

    // Drop a member (merged away); the remaining two now yield a DIFFERENT
    // clusterKey than the one that was actually stored in ignoredMap, so a
    // restore that deletes by group.clusterKey would delete a key that was
    // never stored (bug). ignoredKeys must carry the ORIGINAL stored key.
    const shrunk = findLooseClusters([p('Albert Heijn Amsterdam'), p('Albert Heijn Zuid')]);
    expect(shrunk[0].clusterKey).not.toBe(group[0].clusterKey);

    const { ignored } = splitIgnoredLooseClusters(shrunk, ignoredMap);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].ignoredKeys).toEqual([group[0].clusterKey]);

    // Simulate the sheet's restore path: delete every key in ignoredKeys.
    let next = ignoredMap;
    for (const key of ignored[0].ignoredKeys) next = unignoreCluster(next, key);
    expect(splitIgnoredLooseClusters(shrunk, next).active).toEqual(shrunk);
  });
});

describe('refreshBasket', () => {
  const p = (payee, count = 1) => ({ payee, key: payee.toLowerCase(), count, lastDate: '' });

  it('drops a basket entry whose key no longer exists (merged away)', () => {
    const live = [p('Lidl', 5)];
    const out = refreshBasket([['lidl', p('Lidl', 3)], ['shell', p('Shell', 2)]], live, new Set());
    expect(out.map(([key]) => key)).toEqual(['lidl']);
  });

  it('picks up a live count/spelling change for a still-present key', () => {
    const live = [p('Lidl', 9)];
    const out = refreshBasket([['lidl', p('Lidl', 3)]], live, new Set());
    expect(out).toEqual([['lidl', p('Lidl', 9)]]);
  });

  it('drops a basket entry whose key has since been hidden', () => {
    const live = [p('Lidl', 5)];
    const out = refreshBasket([['lidl', p('Lidl', 3)]], live, new Set(['lidl']));
    expect(out).toEqual([]);
  });

  it('preserves basket order', () => {
    const live = [p('Shell', 1), p('Lidl', 2)];
    const out = refreshBasket([['lidl', p('Lidl', 2)], ['shell', p('Shell', 1)]], live, new Set());
    expect(out.map(([key]) => key)).toEqual(['lidl', 'shell']);
  });
});

describe('hasProcessorPrefix', () => {
  it('detects a recognised card-processor prefix', () => {
    expect(hasProcessorPrefix('PAYPAL *STEAM')).toBe(true);
    expect(hasProcessorPrefix('SQ *Joes Coffee')).toBe(true);
    expect(hasProcessorPrefix('SumUp  * Kahvila Kulma')).toBe(true);
  });
  it('is false for a plain spelling', () => {
    expect(hasProcessorPrefix('Steam')).toBe(false);
    expect(hasProcessorPrefix('Lidl 1234')).toBe(false);
    expect(hasProcessorPrefix('')).toBe(false);
    expect(hasProcessorPrefix(undefined)).toBe(false);
  });
});

describe('preferredTarget', () => {
  it('picks the busiest spelling without a card-processor prefix', () => {
    const members = [
      { key: 'paypal *steam', payee: 'PAYPAL *STEAM', count: 9 },
      { key: 'steam', payee: 'Steam', count: 3 },
      { key: 'steam games', payee: 'Steam Games', count: 2 },
    ];
    expect(preferredTarget(members)?.payee).toBe('Steam');
  });

  it('falls back to the busiest member when every spelling has a prefix', () => {
    const members = [
      { key: 'sq *cafe', payee: 'SQ *CAFE', count: 4 },
      { key: 'sumup *cafe', payee: 'SUMUP *CAFE', count: 1 },
    ];
    expect(preferredTarget(members)?.payee).toBe('SQ *CAFE');
  });

  it('returns null for no members', () => {
    expect(preferredTarget([])).toBeNull();
  });
});

describe('findLooseClusters on a large chain', () => {
  // 800+ payees sharing a chain prefix put one 3-letter block over the cap,
  // and the pairwise pass used to take seconds on it (BACKLOG 2026-09-29).
  const branches = ['Olari', 'Iso Omena', 'Kamppi', 'Tapiola', 'Leppavaara'];
  // Unique, non-numeric endings ("ab17"): a trailing number word would put
  // every row in one exact group first, and exact members skip this pass.
  const tag = (i) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (Math.floor(i / 26) % 26)) + i;
  const chain = Array.from({ length: 2000 }, (_, i) => ({
    payee: `K-Market ${branches[i % 5]} ${tag(i)}`, key: `k${i}`, count: 1,
  }));

  it('stays fast when one block is far over the cap', () => {
    const t0 = performance.now();
    findLooseClusters(chain);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('still groups a typo pair inside an oversized block', () => {
    // A branch no other chain row shares, so neither name is claimed by an
    // exact group first (those leave the loose pool).
    const payees = [
      ...chain,
      { payee: 'K-Market Zzyzx Rode', key: 'typo', count: 3 },
      { payee: 'K-Market Zzyzx Road', key: 'real', count: 9 },
    ];
    const group = findLooseClusters(payees).find(g => g.members.some(m => m.key === 'typo'));
    expect(group?.members.map(m => m.key)).toContain('real');
  });
});
