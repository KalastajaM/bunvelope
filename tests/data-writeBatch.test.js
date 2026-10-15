import { describe, it, expect } from 'vitest';
import { writeBatch, writeJson } from '../js/data.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

describe('writeBatch', () => {
  it('writes all files when every write succeeds', async () => {
    const { folder, files } = createFakeFolder();
    await writeBatch(folder, [
      { filename: 'a.json', data: { x: 1 } },
      { filename: 'b.json', data: { y: 2 } },
    ]);
    expect(JSON.parse(files.get('a.json'))).toEqual({ x: 1 });
    expect(JSON.parse(files.get('b.json'))).toEqual({ y: 2 });
  });

  it('throws when any write fails', async () => {
    const { folder } = createFakeFolder({ failOn: new Set(['b.json']) });
    await expect(writeBatch(folder, [
      { filename: 'a.json', data: { x: 1 } },
      { filename: 'b.json', data: { y: 2 } },
    ])).rejects.toThrow(/b\.json/);
  });

  it('serializes concurrent batches globally', async () => {
    const { folder, files } = createFakeFolder();
    const order = [];
    const wrap = (name, data) => writeBatch(folder, [{ filename: name, data }])
      .then(() => order.push(name));
    await Promise.all([ wrap('a.json', 1), wrap('b.json', 2), wrap('c.json', 3) ]);
    expect(order).toEqual(['a.json', 'b.json', 'c.json']);
    expect(files.size).toBe(3);
  });

  it('a batch blocks single writeJson calls from interleaving', async () => {
    const { folder, files } = createFakeFolder();
    let batchFinished = false;
    const batchP = writeBatch(folder, [
      { filename: 'batch1.json', data: 1 },
      { filename: 'batch2.json', data: 2 },
    ]).then(() => { batchFinished = true; });
    const singleP = writeJson(folder, 'single.json', 9).then(() => {
      // When the single write runs, the batch must have already completed.
      expect(batchFinished).toBe(true);
    });
    await Promise.all([batchP, singleP]);
    expect(files.size).toBe(3);
  });

  it('propagates batch failure to caller even when next write succeeds', async () => {
    const { folder, files } = createFakeFolder({ failOn: new Set(['b.json']) });

    let firstError = null;
    let secondDone = false;

    const batchP = writeBatch(folder, [
      { filename: 'a.json', data: 1 },
      { filename: 'b.json', data: 2 },
    ]).catch(err => { firstError = err; });

    const secondP = writeJson(folder, 'c.json', 3).then(() => { secondDone = true; });

    await Promise.all([batchP, secondP]);

    expect(firstError).not.toBeNull();
    expect(firstError.message).toMatch(/b\.json/);
    expect(secondDone).toBe(true);
    expect(files.has('a.json')).toBe(true);   // partial state, pre-failure
    expect(files.get('b.json')).toBe('');     // created, but close never committed
    expect(files.has('c.json')).toBe(true);   // next write ran after the rejection
  });
});
