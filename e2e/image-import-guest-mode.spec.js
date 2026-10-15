import { test, expect } from '@playwright/test';
import { cspDirectives } from '../server/csp.js';

// Exercise the real browser decoder under the cloud policy without a database
// or an AI request. Synthetic fixtures keep bank data out of the repository.
test('image imports decode and resize under the cloud security policy', async ({ page }) => {
  const policy = Object.entries(cspDirectives()).map(([key, values]) =>
    `${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} ${values.map(value =>
      typeof value === 'function' ? value(null, { locals: { cspNonce: 'test' } }) : value).join(' ')}`,
  ).join('; ');
  await page.route('**/image-import-test', route => route.fulfill({
    contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: '<!doctype html><title>Image import</title>',
  }));
  await page.goto('/image-import-test');
  const result = await page.evaluate(async () => {
    const { fileToContentBlock } = await import('/js/import/downscale.js');
    const violations = [];
    document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
    const results = [];
    for (const [width, height] of [[32, 48], [1125, 2436]]) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').fillRect(0, 0, width, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const block = await fileToContentBlock(new File([blob], 'screenshot.PNG', { type: 'image/png' }));
      const image = new Image();
      image.src = `data:${block.source.media_type};base64,${block.source.data}`;
      await image.decode();
      results.push({ type: block.source.media_type, width: image.naturalWidth, height: image.naturalHeight });
    }
    return { results, violations };
  });
  expect(result).toEqual({ results: [
    { type: 'image/png', width: 32, height: 48 },
    { type: 'image/jpeg', width: 724, height: 1568 },
  ], violations: [] });
});
