// js/data.js — thin re-export from the storage adapter facade.
// Historically this file held the FSAPI implementation directly; that code
// now lives in js/storage/fsapi-adapter.js. The 19 callers that `import
// { ... } from './data.js'` keep working unchanged because every symbol
// they used is re-exported here.

export * from './storage/index.js';
