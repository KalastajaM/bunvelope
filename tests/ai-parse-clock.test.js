import { it, expect, vi } from 'vitest';
vi.mock('../js/ai/transport.js', () => ({ sendMessages: vi.fn(async () => ({ content: [{ type: 'tool_use', name: 'record_rows', input: { rows: [] } }] })) }));
vi.mock('../js/import/downscale.js', () => ({ fileToContentBlock: vi.fn(async () => ({ type: 'text', text: 'receipt' })) }));
import { parseFileWithAi } from '../js/import/ai-parse.js';
import { sendMessages } from '../js/ai/transport.js';
import { fileToContentBlock } from '../js/import/downscale.js';

it('uses the injected local day once, before asynchronous file conversion', async () => {
  const clock = vi.fn(() => new Date(2040, 0, 2, 0, 5));
  fileToContentBlock.mockImplementationOnce(async () => {
    expect(clock).toHaveBeenCalledTimes(1);
    return { type: 'text', text: 'receipt' };
  });
  await parseFileWithAi({}, { state: {}, clock });
  expect(clock).toHaveBeenCalledTimes(1);
  expect(sendMessages.mock.calls.at(-1)[0].messages[0].content[1].text).toContain('use 2040-01-02.');
});

it('refuses an omitted clock before reading a document or making a request', async () => {
  fileToContentBlock.mockClear();
  sendMessages.mockClear();
  await expect(parseFileWithAi({}, { state: {} })).rejects.toThrow('a clock is required');
  expect(fileToContentBlock).not.toHaveBeenCalled();
  expect(sendMessages).not.toHaveBeenCalled();
});
