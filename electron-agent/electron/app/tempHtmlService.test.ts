import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { TempHtmlService } from './tempHtmlService';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { force: true }))); });

describe('TempHtmlService', () => {
  it('writes HTML to a unique temporary file', async () => {
    const path = await new TempHtmlService(tmpdir()).write('<h1>preview</h1>');
    paths.push(path);
    await expect(readFile(path, 'utf8')).resolves.toBe('<h1>preview</h1>');
    expect(path).toMatch(/\.html$/);
  });
});
