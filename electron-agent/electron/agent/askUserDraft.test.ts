import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askUserDraftPath, readAskUserDraft, writeAskUserDraft, deleteAskUserDraft } from './askUserDraft';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('askUserDraft', () => {
  it('round-trips a draft and ignores a mismatched tool call id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ask-draft-'));
    dirs.push(dir);
    const sessionFile = path.join(dir, 's.jsonl');
    const draft = { toolCallId: 'q1', selected: { q1: ['o1'] }, customTexts: { q1: '自定义' }, extraText: '补充', extraImages: [{ type: 'image' as const, mimeType: 'image/png', data: 'aaa' }] };
    await writeAskUserDraft(sessionFile, draft);
    expect(askUserDraftPath(sessionFile)).toBe(`${sessionFile}.ask-user-draft.json`);
    expect(await readAskUserDraft(sessionFile, 'q1')).toEqual(draft);
    expect(await readAskUserDraft(sessionFile, 'other')).toBeNull();
    await deleteAskUserDraft(sessionFile);
    expect(await readAskUserDraft(sessionFile, 'q1')).toBeNull();
    await readFile(`${sessionFile}.ask-user-draft.json`).catch((error: NodeJS.ErrnoException) => {
      expect(error.code).toBe('ENOENT');
    });
  });

  it('returns null for corrupt json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ask-draft-'));
    dirs.push(dir);
    const sessionFile = path.join(dir, 's.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${sessionFile}.ask-user-draft.json`, '{');
    expect(await readAskUserDraft(sessionFile, 'q1')).toBeNull();
  });
});
