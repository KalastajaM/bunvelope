import { describe, it, expect, vi } from 'vitest';
import { createFakeFolder } from './_fakes/fakeFolder.js';
import { createAutomaticBackup, restoreMigrationBackup, writeBatch, loadBudgetData } from '../js/storage/fsapi-adapter.js';
import { createBackupController, retainedSnapshots, BACKUP_INTERVAL } from '../js/storage/automatic-backups.js';

function budget() {
  const source = createFakeFolder();
  for (const name of ['envelopes', 'budget-items', 'transactions', 'accounts', 'envelope-templates']) source.files.set(`${name}.json`, '[]');
  source.files.set('budget-meta.json', '{"schemaVersion":8,"name":"Original"}');
  return source;
}
const metadata = () => ({ owner: 'test-budget', timestamp: Date.UTC(2026, 9, 8, 12) });

describe('automatic folder snapshots', () => {
  it('serializes with saves and restores exact files into a fresh usable budget', async () => {
    const source = budget(); const target = createFakeFolder();
    const save = writeBatch(source.folder, [{ filename: 'budget-meta.json', data: { schemaVersion: 8, name: 'Saved' } }]);
    const name = await createAutomaticBackup(source.folder, target.folder, metadata());
    await save;
    const snapshot = target.subdirs.get(name);
    const restored = createFakeFolder();
    await restoreMigrationBackup(snapshot.folder, restored.folder);
    for (const [file, text] of source.files) {
      if (file !== '.bunvelope-publish.json') expect(restored.files.get(file)).toBe(text);
    }
    expect((await loadBudgetData(restored.folder)).meta.name).toBe('Saved');
    expect(JSON.parse(snapshot.files.get('migration-backup.json'))).toMatchObject({ kind: 'automatic', owner: 'test-budget' });
  });
  it('does not back up partial, corrupt, newer-schema or unrecovered data', async () => {
    for (const damage of [s => s.files.delete('accounts.json'), s => s.files.set('transactions.json', '{'),
      s => s.files.set('budget-meta.json', '{"schemaVersion":99}'),
      s => s.files.set('.bunvelope-publish.json', '{"version":2}')]) {
      const source = budget(); const target = createFakeFolder(); damage(source);
      await expect(createAutomaticBackup(source.folder, target.folder, metadata())).rejects.toThrow();
      expect(target.subdirs.size).toBe(0);
    }
  });
  it('refuses revoked permissions without prompting or claiming success', async () => {
    const target = createFakeFolder({ permission: 'prompt' });
    target.folder.requestPermission = vi.fn();
    await expect(createAutomaticBackup(budget().folder, target.folder, metadata())).rejects.toThrow('permission');
    expect(target.folder.requestPermission).not.toHaveBeenCalled();
    expect(target.subdirs.size).toBe(0);
  });
  it('rejects readback corruption and never completes the manifest', async () => {
    const target = createFakeFolder();
    const broken = createFakeFolder();
    const get = broken.folder.getFileHandle;
    broken.folder.getFileHandle = async (...args) => {
      const handle = await get(...args);
      if (args[0] === 'accounts.json') handle.getFile = async () => ({ text: async () => 'corrupt' });
      return handle;
    };
    target.folder.getDirectoryHandle = async () => broken.folder;
    await expect(createAutomaticBackup(budget().folder, target.folder, metadata())).rejects.toThrow('verification');
    expect(broken.files.has('migration-backup.json')).toBe(false);
  });
  it('rejects a corrupt snapshot before touching a restore destination', async () => {
    const target = createFakeFolder();
    const name = await createAutomaticBackup(budget().folder, target.folder, metadata());
    const snapshot = target.subdirs.get(name);
    snapshot.files.set('transactions.json', '[{}]');
    const restored = createFakeFolder();
    await expect(restoreMigrationBackup(snapshot.folder, restored.folder)).rejects.toThrow('verification');
    expect(restored.files.size).toBe(0);
  });
});

function harness() {
  let time = Date.UTC(2026, 9, 8);
  const saved = new Map();
  const preferences = vi.fn(async value => {
    if (value) saved.set(value.id, { ...value });
    else return [...saved.values()];
  });
  const source = { isSameEntry: async other => source === other, resolve: async () => null };
  const destination = { name: 'Cloud folder', resolve: async () => null };
  const snapshot = vi.fn(async () => 'snapshot');
  const cleanup = vi.fn();
  const options = { preferences, clock: () => time, snapshot, cleanup };
  return { controller: createBackupController(options), options, snapshot, cleanup, source, destination, saved,
    advance: delta => { time += delta; } };
}

describe('backup scheduling and health', () => {
  it('persists the destination, backs up immediately and hourly, and catches up after restart', async () => {
    const h = harness();
    await h.controller.configure(h.source, h.destination);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    await h.controller.tick(h.source);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    h.advance(BACKUP_INTERVAL);
    await h.controller.tick(h.source);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    h.advance(3 * BACKUP_INTERVAL);
    const restarted = createBackupController(h.options);
    await restarted.tick(h.source);
    expect(h.snapshot).toHaveBeenCalledTimes(3);
    expect(restarted.status(h.source)).toMatchObject({ enabled: true, overdue: false, error: null });
  });
  it('retries failure without pruning or advancing the last verified time', async () => {
    const h = harness();
    await h.controller.configure(h.source, h.destination);
    const before = h.controller.status(h.source).lastSuccess;
    h.advance(3 * BACKUP_INTERVAL);
    h.snapshot.mockRejectedValueOnce(new Error('disk full'));
    await h.controller.tick(h.source);
    expect(h.controller.status(h.source)).toMatchObject({ lastSuccess: before, error: 'disk full', overdue: true });
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    await h.controller.tick(h.source);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    h.advance(5 * 60 * 1000);
    await h.controller.tick(h.source);
    expect(h.controller.status(h.source).error).toBeNull();
  });
  it('retries retention failures after five minutes without losing a verified copy', async () => {
    const h = harness();
    h.cleanup.mockRejectedValueOnce(new Error('cleanup denied'));
    await h.controller.configure(h.source, h.destination);
    expect(h.controller.status(h.source).lastSuccess).not.toBeNull();
    expect(h.controller.status(h.source).error).toBe('cleanup denied');
    h.advance(5 * 60 * 1000);
    await h.controller.tick(h.source);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    expect(h.controller.status(h.source).error).toBeNull();
  });
  it('disabling persists across restarts and never deletes existing copies', async () => {
    const h = harness();
    await h.controller.configure(h.source, h.destination);
    await h.controller.disable(h.source);
    h.advance(3 * BACKUP_INTERVAL);
    await createBackupController(h.options).tick(h.source);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent requests and isolates different budgets', async () => {
    const h = harness();
    await h.controller.configure(h.source, h.destination);
    let finish;
    h.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = h.controller.run(h.source, true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const second = h.controller.run(h.source, true);
    const other = h.controller.tick({ name: 'other', isSameEntry: async () => false });
    finish();
    await Promise.all([first, second, other]);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });
  it('refuses related source/destination folders', async () => {
    const h = harness();
    await expect(h.controller.configure(h.source, h.source)).rejects.toThrow('separate');
    h.source.resolve = async () => ['child'];
    await expect(h.controller.configure(h.source, h.destination)).rejects.toThrow('separate');
    expect(h.snapshot).not.toHaveBeenCalled();
  });
  it('retains hourly/daily/monthly recovery points independently of timezone or long gaps', () => {
    const snapshots = Array.from({ length: 400 }, (_, i) => ({ name: String(i), timestamp: Date.UTC(2025, 0, 1) + i * 86400000 }));
    const keep = retainedSnapshots(snapshots);
    expect(keep.has('399')).toBe(true);
    expect(keep.has('370')).toBe(true);
    expect(keep.has('0')).toBe(false);
    expect(keep.size).toBeGreaterThan(30);
    expect(keep.size).toBeLessThanOrEqual(66);
  });
});

describe('retention only touches owned completed snapshots', () => {
  it('keeps other budgets, incomplete snapshots, migration backups and user-added content', async () => {
    const source = budget();
    source.folder.isSameEntry = async other => source.folder === other;
    source.folder.resolve = async () => null;
    const target = createFakeFolder();
    target.folder.resolve = async () => null;
    const saved = new Map();
    let timestamp = Date.UTC(2025, 0, 1);
    const controller = createBackupController({ snapshot: createAutomaticBackup,
      clock: () => timestamp, preferences: async value => {
        if (value) saved.set(value.id, value);
        else return [...saved.values()];
      } });
    await controller.configure(source.folder, target.folder);
    const oldest = [...target.subdirs.keys()][0];
    target.subdirs.get(oldest).files.set('personal-note.txt', 'keep');
    const other = await createAutomaticBackup(source.folder, target.folder, { owner: 'someone-else', timestamp });
    await target.folder.getDirectoryHandle('snapshot-incomplete', { create: true });
    await target.folder.getDirectoryHandle('backup-v6', { create: true });
    for (let day = 1; day <= 65; day++) {
      timestamp += 86400000;
      await controller.run(source.folder, true);
    }
    expect(controller.status(source.folder).error).toBeNull();
    expect(target.subdirs.has(oldest)).toBe(true);
    expect(target.subdirs.has(other)).toBe(true);
    expect(target.subdirs.has('snapshot-incomplete')).toBe(true);
    expect(target.subdirs.has('backup-v6')).toBe(true);
    expect(target.subdirs.size).toBeLessThan(45);
    expect(target.subdirs.size).toBeGreaterThan(30);
  });
});

describe('database budget backup preferences', () => {
  it('remembers by budget ID without persisting the decrypted cache, and separates budgets with equal names', async () => {
    const h = harness();
    const source = { kind: 'cloud', budgetId: 'one', name: 'Budget', version: 4, __cache: { secret: 'not for IDB' } };
    await h.controller.configure(source, h.destination);
    expect([...h.saved.values()][0].source).toEqual({ kind: 'cloud', budgetId: 'one' });
    h.advance(3 * BACKUP_INTERVAL);
    const restarted = createBackupController(h.options);
    const reopened = { kind: 'cloud', budgetId: 'one', version: 8, name: 'Renamed' };
    await restarted.tick(reopened);
    expect(restarted.status(reopened).enabled).toBe(true);
    expect(h.snapshot).toHaveBeenLastCalledWith(reopened, h.destination, expect.any(Object));
    const other = { kind: 'cloud', budgetId: 'two', name: 'Budget' };
    await restarted.tick(other);
    expect(restarted.status(other).enabled).toBe(false);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });
});
