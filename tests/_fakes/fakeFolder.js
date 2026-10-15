/**
 * In-memory FileSystemDirectoryHandle fake.
 * Supports getFileHandle(name, {create}), createWritable(), queryPermission,
 * requestPermission, and getDirectoryHandle(name, {create}) — subdirectories
 * are nested fakes exposed via `subdirs` (Map<string, {folder, files, subdirs}>)
 * so tests can assert on migration backups.
 * Writes stored in `files` (Map<string, string>).
 * `failOn` set — any write to a filename in this set throws.
 */
export function createFakeFolder({ failOn = new Set(), permission = 'granted', failClose = () => false } = {}) {
  const files = new Map();
  const subdirs = new Map();
  const folder = {
    name: 'fake',
    kind: 'directory',
    async *entries() {
      for (const name of files.keys()) yield [name, { kind: 'file', name }];
      for (const [name, child] of subdirs) yield [name, child.folder];
    },
    async removeEntry(name) {
      if (subdirs.has(name) && (subdirs.get(name).files.size || subdirs.get(name).subdirs.size)) throw new Error('not empty');
      files.delete(name); subdirs.delete(name);
    },
    async *values() { yield* files.keys(); yield* subdirs.keys(); },
    queryPermission: async () => permission,
    requestPermission: async () => permission,
    async getDirectoryHandle(name, opts) {
      if (!subdirs.has(name)) {
        if (!opts?.create) {
          const err = new Error('not found'); err.name = 'NotFoundError'; throw err;
        }
        subdirs.set(name, createFakeFolder({ permission }));
      }
      return subdirs.get(name).folder;
    },
    async getFileHandle(filename, opts) {
      if (!files.has(filename) && !opts?.create) {
        const err = new Error('not found'); err.name = 'NotFoundError'; throw err;
      }
      if (!files.has(filename)) files.set(filename, '');
      return {
        async getFile() {
          const text = files.get(filename) ?? '';
          return { text: async () => text };
        },
        async createWritable() {
          if (failOn.has(filename)) throw new Error(`fake write failure on ${filename}`);
          let buf = '';
          return {
            write: async (chunk) => { buf += chunk; },
            close: async () => {
              if (await failClose(filename, buf)) throw new Error(`fake close failure on ${filename}`);
              files.set(filename, buf);
            },
          };
        },
      };
    },
  };
  return { folder, files, subdirs };
}
