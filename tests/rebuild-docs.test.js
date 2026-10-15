import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The rebuild specification in docs/rebuild/ is the load-bearing artifact for
// the v2 rebuild (see docs/rebuild/README.md). These checks are the doc
// equivalent of a failing test: a cross-reference that no longer resolves, or
// a drifted divergence-marker count, means the spec is lying about itself.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = join(repoRoot, 'docs', 'rebuild');

function mdFilesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) mdFilesUnder(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const docs = mdFilesUnder(docsRoot).map((path) => ({
  path,
  rel: path.slice(repoRoot.length + 1),
  text: readFileSync(path, 'utf8'),
}));

test('the rebuild docs exist', () => {
  expect(docs.length).toBeGreaterThan(0);
});

describe('divergence markers', () => {
  const MARKER = '⚠️ **DIVERGES FROM v1**';
  // The README's template and its quoted copy in 00-architecture.md both
  // carry the placeholder text; every normative marker replaces it.
  const TEMPLATE_PLACEHOLDER = '*what v1 does, why it is wrong, what v2 must do.*';

  test('README count matches the actual marker count', () => {
    const readme = docs.find((d) => d.rel === 'docs/rebuild/README.md');
    const claim = readme.text.match(/There are (\d+) such markers/);
    expect(claim, 'README.md must state the marker count as "There are N such markers"').not.toBeNull();

    let normative = 0;
    for (const d of docs) {
      for (const line of d.text.split('\n')) {
        if (!line.includes(MARKER)) continue;
        if (line.includes(TEMPLATE_PLACEHOLDER)) continue; // the template itself
        normative += 1;
      }
    }
    expect(
      Number(claim[1]),
      `README claims ${claim[1]} divergence markers but the docs contain ${normative} — update the README's count`,
    ).toBe(normative);
  });
});

describe('calendar fixtures are well-formed', () => {
  const calDir = join(docsRoot, 'fixtures', 'calendar');
  const files = existsSync(calDir)
    ? readdirSync(calDir).filter((n) => n.endsWith('.json'))
    : [];

  test('fixture files exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    test(name, () => {
      const fixture = JSON.parse(readFileSync(join(calDir, name), 'utf8'));
      expect(fixture.calendar).toBe(name.replace(/\.json$/, ''));
      expect(Array.isArray(fixture.sources)).toBe(true);
      expect(fixture.sources.length).toBeGreaterThan(0);
      for (const [year, dates] of Object.entries(fixture.years)) {
        expect(Array.isArray(dates)).toBe(true);
        let prev = '';
        for (const date of dates) {
          expect(date, `${name} ${year}: malformed date ${date}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(date.slice(0, 4), `${name}: ${date} filed under ${year}`).toBe(year);
          // Round-trip: a fake calendar day (e.g. Feb 30) rolls over and fails this.
          const [y, m, d] = date.split('-').map(Number);
          const roundTrip = new Date(Date.UTC(y, m - 1, d));
          expect(
            [roundTrip.getUTCFullYear(), roundTrip.getUTCMonth() + 1, roundTrip.getUTCDate()],
            `${name}: ${date} is not a real calendar day`,
          ).toEqual([y, m, d]);
          expect(date > prev, `${name} ${year}: ${date} out of order or duplicated`).toBe(true);
          prev = date;
        }
      }
    });
  }
});

describe('scenario index matches the directory', () => {
  const scenarioDir = join(docsRoot, 'fixtures', 'scenarios');
  const hasScenarios = existsSync(scenarioDir);

  test('README table and files agree', () => {
    if (!hasScenarios) return;
    const readme = readFileSync(join(scenarioDir, 'README.md'), 'utf8');
    const listed = [...readme.matchAll(/`(\d{2}-[a-z0-9-]+\.md)`/g)].map((m) => m[1]);
    const onDisk = readdirSync(scenarioDir).filter((n) => /^\d{2}-.*\.md$/.test(n));
    expect(listed.sort()).toEqual(onDisk.sort());
  });
});

describe('cross-references resolve', () => {
  // Both reference forms used throughout the spec:
  //   [label](relative/path.md#anchor)   — markdown links
  //   `relative/path.md`                 — backticked file mentions
  const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
  const TICK_RE = /`([^`\s]+\.md)`/g;

  function targetsIn(text) {
    const targets = [];
    for (const m of text.matchAll(LINK_RE)) targets.push(m[1]);
    for (const m of text.matchAll(TICK_RE)) targets.push(m[1]);
    return targets
      .filter((t) => !/^[a-z]+:/i.test(t)) // external URLs
      .filter((t) => !t.startsWith('#')) // same-file anchors
      .map((t) => t.split('#')[0])
      .filter((t) => t.endsWith('.md'));
  }

  for (const doc of docs) {
    test(doc.rel, () => {
      const broken = [];
      for (const target of targetsIn(doc.text)) {
        const fromDoc = resolve(dirname(doc.path), target);
        const fromRepoRoot = resolve(repoRoot, target);
        if (!existsSync(fromDoc) && !existsSync(fromRepoRoot)) broken.push(target);
      }
      expect(broken, `broken references in ${doc.rel}: ${broken.join(', ')}`).toEqual([]);
    });
  }
});
