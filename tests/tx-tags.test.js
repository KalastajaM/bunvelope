import { describe, it, expect } from 'vitest';
import { extractTxTags, txHasTag, collectAllTags } from '../js/engine/tx-tags.js';

describe('extractTxTags', () => {
  it('returns [] for empty / non-string input', () => {
    expect(extractTxTags(null)).toEqual([]);
    expect(extractTxTags(undefined)).toEqual([]);
    expect(extractTxTags('')).toEqual([]);
    expect(extractTxTags(42)).toEqual([]);
  });

  it('extracts a single tag', () => {
    expect(extractTxTags('coffee #treat')).toEqual(['treat']);
  });

  it('extracts multiple tags preserving first-seen order, lowercased, deduped', () => {
    expect(extractTxTags('Trip #Paris and #food then #Paris again'))
      .toEqual(['paris', 'food']);
  });

  it('matches tags at the start of the string', () => {
    expect(extractTxTags('#kickoff lunch')).toEqual(['kickoff']);
  });

  it('supports digits, hyphens, underscores in tag names', () => {
    expect(extractTxTags('#trip-2026 #q1_review #2024')).toEqual(['trip-2026', 'q1_review', '2024']);
  });

  it('supports Unicode letters (Finnish ä/ö, etc.)', () => {
    expect(extractTxTags('#kahvi #päivä')).toEqual(['kahvi', 'päivä']);
  });

  it('ignores `#` that is not preceded by whitespace (e.g. URL fragments)', () => {
    expect(extractTxTags('see https://example.com/page#frag for more')).toEqual([]);
    expect(extractTxTags('a#nottag and #tag')).toEqual(['tag']);
  });

  it('stops at non-tag characters', () => {
    expect(extractTxTags('#tag, then #other!')).toEqual(['tag', 'other']);
  });
});

describe('txHasTag', () => {
  it('returns true when the note contains the tag, case-insensitively', () => {
    expect(txHasTag({ note: 'a #Trip note' }, 'trip')).toBe(true);
    expect(txHasTag({ note: 'a #trip note' }, 'TRIP')).toBe(true);
  });

  it('returns false when the tag is missing or empty', () => {
    expect(txHasTag({ note: 'a #other note' }, 'trip')).toBe(false);
    expect(txHasTag({ note: '' }, 'trip')).toBe(false);
    expect(txHasTag(null, 'trip')).toBe(false);
    expect(txHasTag({ note: '#trip' }, '')).toBe(false);
  });

  it('matches exact tag, not substring (so #tripoli does not match `trip`)', () => {
    expect(txHasTag({ note: '#tripoli' }, 'trip')).toBe(false);
  });
});

describe('collectAllTags', () => {
  it('returns [] for missing input', () => {
    expect(collectAllTags(null)).toEqual([]);
    expect(collectAllTags([])).toEqual([]);
  });

  it('counts usages and sorts by count desc then tag asc', () => {
    const txs = [
      { note: '#food #coffee' },
      { note: '#food brunch' },
      { note: 'no tag here' },
      { note: '#food #trip' },
    ];
    expect(collectAllTags(txs)).toEqual([
      { tag: 'food', count: 3 },
      { tag: 'coffee', count: 1 },
      { tag: 'trip', count: 1 },
    ]);
  });

  it('deduplicates within a single tx note', () => {
    const txs = [{ note: '#paris #paris #paris' }];
    expect(collectAllTags(txs)).toEqual([{ tag: 'paris', count: 1 }]);
  });
});
