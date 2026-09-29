import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowBackgroundStore } from './windowBackground';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gren-window-bg-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WindowBackgroundStore', () => {
  it('has no color before anything was saved', () => {
    expect(new WindowBackgroundStore(tempDir()).read()).toBeUndefined();
  });

  it('remembers the saved color for the next launch', async () => {
    const dir = tempDir();
    await new WindowBackgroundStore(dir).save('#ffffff');
    expect(new WindowBackgroundStore(dir).read()).toBe('#ffffff');
  });

  it('ignores a corrupted or non-hex file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'window-background.json'), '{');
    expect(new WindowBackgroundStore(dir).read()).toBeUndefined();
    writeFileSync(join(dir, 'window-background.json'), JSON.stringify({ backgroundColor: 'red' }));
    expect(new WindowBackgroundStore(dir).read()).toBeUndefined();
  });

  it('rejects colors that are not hex', async () => {
    await expect(new WindowBackgroundStore(tempDir()).save('url(x)')).rejects.toThrow();
  });
});
