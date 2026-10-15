import { beforeEach, expect, it } from 'vitest';
import { GUEST_FOLDER, resetGuestMemory, replaceGuestMemory, writeBatch, readJson } from '../js/storage/guest-adapter.js';

beforeEach(() => resetGuestMemory());

it('retains every old file when a later replacement file is invalid', async () => {
  const old = [{ filename: 'accounts.json', data: [{ id: 'old', name: 'Old account' }] },
    { filename: 'budget-meta.json', data: { name: 'Old budget', schemaVersion: 8 } }];
  await writeBatch(GUEST_FOLDER, old);
  expect(() => replaceGuestMemory([
    { filename: 'accounts.json', data: [{ id: 'new', name: 'New account' }] },
    { filename: 'transactions.json', data: 'invalid' },
  ])).toThrow();
  for (const { filename, data } of old) expect(await readJson(GUEST_FOLDER, filename)).toEqual(data);
  expect(await readJson(GUEST_FOLDER, 'transactions.json')).toBeNull();
});

it('replaces all files together and takes a copy of the input', async () => {
  await writeBatch(GUEST_FOLDER, [{ filename: 'accounts.json', data: [{ id: 'old', name: 'Old account' }] }]);
  const meta = { name: 'New budget', schemaVersion: 8 };
  replaceGuestMemory([{ filename: 'budget-meta.json', data: meta }]);
  meta.name = 'Changed outside storage';
  expect(await readJson(GUEST_FOLDER, 'accounts.json')).toBeNull();
  expect(await readJson(GUEST_FOLDER, 'budget-meta.json')).toEqual({ name: 'New budget', schemaVersion: 8 });
});
