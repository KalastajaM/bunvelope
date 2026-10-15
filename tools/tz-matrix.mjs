#!/usr/bin/env node
/**
 * Run the suite in four timezones, not one.
 *
 * Ported from the v2 rebuild, whose own copy of this script carries the
 * reason: a v1 DST test failed locally and passed in CI for an unknown
 * period, because CI runs UTC — the one zone in which the entire date bug
 * class is invisible. This repo's CI has the same blind spot, and this repo
 * is the one with the DST bug in its history (`tests/engine/dst-day-spans.test.js`,
 * `tests/engine/history-tz.test.js`).
 *
 * The zones are chosen to be awkward in different ways:
 *
 *   UTC                    — no offset. What CI has always run.
 *   Europe/Helsinki        — the owner's zone, ahead of UTC, DST in March/October.
 *   America/Los_Angeles    — behind UTC, so `new Date('2026-03-01')` (parsed as
 *                            UTC midnight) is still February locally. This is
 *                            the zone that catches month-boundary reads.
 *   Australia/Lord_Howe    — a 30-minute DST shift on a +10:30 base. Anything
 *                            assuming whole-hour offsets or 24-hour days fails
 *                            here and nowhere else.
 *
 * Usage: node tools/tz-matrix.mjs [vitest args...]
 */
import { spawnSync } from 'node:child_process';

const ZONES = ['UTC', 'Europe/Helsinki', 'America/Los_Angeles', 'Australia/Lord_Howe'];
const args = process.argv.slice(2);
const failed = [];

for (const TZ of ZONES) {
  process.stdout.write(`\n─── TZ=${TZ} ${'─'.repeat(Math.max(0, 60 - TZ.length))}\n`);
  const r = spawnSync('npx', ['vitest', 'run', ...args], {
    stdio: 'inherit',
    env: { ...process.env, TZ },
  });
  if (r.status !== 0) {
    failed.push(TZ);
    process.stdout.write(`\n✗ suite failed under TZ=${TZ}\n`);
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length}/${ZONES.length} timezones failed: ${failed.join(', ')}`);
  console.error('All four are required — a date bug that only appears outside UTC is still a date bug.');
  process.exit(1);
}
console.log(`\n✓ all ${ZONES.length} timezones green`);
