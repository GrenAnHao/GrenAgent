import { describe, it, expect, vi } from 'vitest';

vi.mock('./files', () => ({
  files: {
    read: vi.fn(async (_workspace: string, path: string) => `content-of-${path}`),
    readBinary: vi.fn(async () => ({
      mime_type: 'image/png',
      data: 'abc123',
      size: 3,
    })),
  },
}));

import {
  buildFileContextPrefix,
  buildPromptPayload,
  mergePromptWithFileContext,
} from './contextPayload';

describe('contextPayload', () => {
  it('builds pi file tags', async () => {
    const { textPrefix } = await buildFileContextPrefix('.', ['D:\\a.ts']);
    expect(textPrefix).toContain('<file name="D:\\a.ts">');
    expect(textPrefix).toContain('content-of-D:\\a.ts');
  });

  it('collects image attachments separately', async () => {
    const { textPrefix, images } = await buildFileContextPrefix('.', ['photo.png']);
    expect(textPrefix).toBe('');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'abc123' });
  });

  it('merges prefix with user text', () => {
    const merged = mergePromptWithFileContext('<file name="a">x</file>\n\n', 'hello');
    expect(merged).toContain('<file name="a">');
    expect(merged).toContain('hello');
  });

  it('builds full prompt payload', async () => {
    const payload = await buildPromptPayload('.', ['a.ts'], 'hi');
    expect(payload.message).toContain('hi');
    expect(payload.message).toContain('<file name="a.ts">');
    expect(payload.images).toEqual([]);
  });
});
