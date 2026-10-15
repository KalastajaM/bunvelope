import { describe, it, expect } from 'vitest';
import { createFakeFolder } from './_fakes/fakeFolder.js';
import { loadBudgetData, restoreMigrationBackup } from '../js/storage/fsapi-adapter.js';

function legacy() {
  const f = createFakeFolder();
  for (const name of ['accounts', 'envelopes', 'transactions', 'budget-items', 'envelope-templates']) f.files.set(`${name}.json`, ' [ ]\n');
  f.files.set('budget-meta.json', '{"schemaVersion":6,"name":"Before","write_seq":9}');
  return f;
}
describe('complete migration backup and restore', () => {
  it('preserves all six exact files and restores the older schema without migrating', async () => {
    const source = legacy(); const original = new Map(source.files);
    await loadBudgetData(source.folder);
    const backup = [...source.subdirs.values()][0];
    expect(backup.files.size).toBe(7);
    for (const [name, text] of original) expect(backup.files.get(name)).toBe(text);
    const dest = createFakeFolder();
    await restoreMigrationBackup(backup.folder, dest.folder);
    expect(new Map([...dest.files].filter(([name]) => name !== '.bunvelope-restore.json'))).toEqual(original);
    expect(JSON.parse(source.files.get('budget-meta.json')).schemaVersion).toBe(8);
  });
  it('preserves absent files and refuses corrupt or incomplete backups before writing', async () => {
    const source = legacy(); source.files.delete('envelope-templates.json');
    await loadBudgetData(source.folder);
    const backup = [...source.subdirs.values()][0];
    const dest = createFakeFolder();
    await restoreMigrationBackup(backup.folder, dest.folder);
    expect(dest.files.has('envelope-templates.json')).toBe(false);
    backup.files.set('accounts.json', '[{}]');
    const empty = createFakeFolder();
    await expect(restoreMigrationBackup(backup.folder, empty.folder)).rejects.toThrow('verification');
    expect(empty.files.size).toBe(0);
    backup.files.delete('migration-backup.json');
    await expect(restoreMigrationBackup(backup.folder, empty.folder)).rejects.toThrow('Invalid');
  });
  it('refuses nonempty destinations, including unrelated files', async () => {
    const source = legacy(); await loadBudgetData(source.folder);
    const dest = createFakeFolder(); dest.files.set('notes.txt', 'keep');
    await expect(restoreMigrationBackup([...source.subdirs.values()][0].folder, dest.folder)).rejects.toThrow('empty');
    expect([...dest.files]).toEqual([['notes.txt', 'keep']]);
  });
  it('does not migrate when the backup cannot be committed', async () => {
    const source = legacy(); const original = new Map(source.files);
    source.folder.getDirectoryHandle = async () => createFakeFolder({ failOn: new Set(['migration-backup.json']) }).folder;
    await expect(loadBudgetData(source.folder)).rejects.toThrow('fake write failure');
    expect(source.files).toEqual(original);
  });
  it('does not back up current or newer schemas', async () => {
    for (const schemaVersion of [8, 99]) {
      const source = legacy(); source.files.set('budget-meta.json', JSON.stringify({ schemaVersion }));
      if (schemaVersion === 8) await loadBudgetData(source.folder);
      else await expect(loadBudgetData(source.folder)).rejects.toThrow('newer');
      expect(source.subdirs.size).toBe(0);
    }
  });
  it('retains the backup after a failed restore so another empty destination can be used', async () => {
    const source = legacy(); await loadBudgetData(source.folder);
    const backup = [...source.subdirs.values()][0]; const before = new Map(backup.files);
    const failed = createFakeFolder({ failOn: new Set(['transactions.json']) });
    await expect(restoreMigrationBackup(backup.folder, failed.folder)).rejects.toThrow();
    expect(backup.files).toEqual(before);
    await expect(loadBudgetData(failed.folder)).rejects.toThrow('Incomplete backup restoration');
    await restoreMigrationBackup(backup.folder, createFakeFolder().folder);
  });
});
