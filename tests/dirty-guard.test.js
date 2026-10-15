import { describe, test, expect, vi } from 'vitest';
import { createDirtyTracker } from '../js/ui/dirty-guard.js';

describe('createDirtyTracker', () => {
  test('clean tracker closes without consulting confirm', () => {
    const confirm = vi.fn(() => false);
    const tracker = createDirtyTracker({ confirm });
    expect(tracker.isDirty()).toBe(false);
    expect(tracker.confirmClose()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  test('dirty tracker returns the confirm result', () => {
    const confirm = vi.fn(() => false);
    const tracker = createDirtyTracker({ confirm });
    tracker.markDirty();
    expect(tracker.isDirty()).toBe(true);
    expect(tracker.confirmClose()).toBe(false);
    confirm.mockReturnValueOnce(true);
    expect(tracker.confirmClose()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test('passes through an async confirm (promise result)', async () => {
    const confirm = vi.fn(async () => true);
    const tracker = createDirtyTracker({ confirm });
    tracker.markDirty();
    await expect(tracker.confirmClose()).resolves.toBe(true);
  });

  test('reset returns the tracker to clean', () => {
    const confirm = vi.fn(() => false);
    const tracker = createDirtyTracker({ confirm });
    tracker.markDirty();
    tracker.reset();
    expect(tracker.isDirty()).toBe(false);
    expect(tracker.confirmClose()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  test('markDirty is idempotent and survives repeated confirms', () => {
    const confirm = vi.fn(() => false);
    const tracker = createDirtyTracker({ confirm });
    tracker.markDirty();
    tracker.markDirty();
    expect(tracker.confirmClose()).toBe(false);
    expect(tracker.isDirty()).toBe(true); // a declined confirm keeps it dirty
  });
});
