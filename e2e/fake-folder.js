// e2e/fake-folder.js — an in-page stand-in for the File System Access API's
// directory picker, backed by a Map that lives in the Playwright (Node)
// process.
//
// Chromium's real showDirectoryPicker() opens a native dialog that headless
// automation cannot drive. The app looks `window.showDirectoryPicker` up at
// call time (js/storage/fsapi-adapter.js openBudgetFolder), so the seam is
// simply replacing that one function before the app loads — no production
// change. Everything after the pick (getFileHandle / getFile / createWritable /
// getDirectoryHandle / queryPermission / isSameEntry) is the real FSAPI
// adapter talking to this fake, so the specs exercise the genuine read, migrate,
// journal-publish and write paths and can assert on the files that "hit disk".
//
// Backing the fake with a Node-side Map (rather than one inside the page) is
// what lets a file survive a page reload, the way a real folder does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The six files of a budget folder, read from a directory of the repo. */
export function readBudgetFolder(relDir) {
  const dir = path.join(REPO, relDir);
  const files = new Map();
  for (const name of [
    'envelopes.json', 'budget-items.json', 'transactions.json',
    'accounts.json', 'envelope-templates.json', 'budget-meta.json',
  ]) {
    files.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return files;
}

/**
 * Install the fake picker on `page`. Call before the first navigation.
 * @param {import('@playwright/test').Page} page
 * @param {Map<string, string>} files  the "disk": path (sub/dir/name) → text
 * @returns {{ files: Map<string, string>, picks: () => number }}
 */
export async function installFakeFolder(page, files = new Map()) {
  let picks = 0;
  await page.exposeFunction('__bvFsRead', (p) => (files.has(p) ? files.get(p) : null));
  await page.exposeFunction('__bvFsWrite', (p, text) => { files.set(p, text); });
  await page.exposeFunction('__bvFsPicked', () => { picks += 1; });

  await page.addInitScript(() => {
    const notFound = (what) => {
      const err = new Error(`${what} not found`);
      err.name = 'NotFoundError';
      return err;
    };
    // `prefix` is '' for the picked folder, 'backup-x/' for a subdirectory.
    const dir = (prefix) => ({
      kind: 'directory',
      name: prefix ? prefix.replace(/\/$/, '').split('/').pop() : 'e2e-budget-folder',
      __prefix: prefix,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      isSameEntry: async (other) => !!other && other.__prefix === prefix,
      async getDirectoryHandle(name) {
        return dir(`${prefix}${name}/`);
      },
      async getFileHandle(name, opts) {
        const p = prefix + name;
        if ((await window.__bvFsRead(p)) === null) {
          if (!opts || !opts.create) throw notFound(name);
          // A real FSAPI creates the empty destination straight away.
          await window.__bvFsWrite(p, '');
        }
        return {
          kind: 'file',
          name,
          async getFile() {
            const text = (await window.__bvFsRead(p)) ?? '';
            return { name, text: async () => text };
          },
          async createWritable() {
            let buf = '';
            return {
              write: async (chunk) => { buf += typeof chunk === 'string' ? chunk : String(chunk); },
              close: async () => { await window.__bvFsWrite(p, buf); },
            };
          },
        };
      },
    });
    window.showDirectoryPicker = async () => {
      await window.__bvFsPicked();
      return dir('');
    };
  });

  return { files, picks: () => picks };
}
