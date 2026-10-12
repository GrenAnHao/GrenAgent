import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeGraphIndexHint } from './prompt.js';

function tempWorkspace(indexed: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), indexed ? 'pi-cg-yes-' : 'pi-cg-no-'));
  if (indexed) {
    mkdirSync(join(cwd, '.codegraph'));
    writeFileSync(join(cwd, '.codegraph', 'codegraph.db'), '');
  }
  return cwd;
}

describe('codeGraphIndexHint', () => {
  it('tells the model to start with CodeGraph when the project is indexed', () => {
    const hint = codeGraphIndexHint(tempWorkspace(true));
    expect(hint).toMatch(/has a CodeGraph index/i);
    expect(hint).toMatch(/code_explore/);
    expect(hint).not.toMatch(/code_\*/);
    expect(hint).toMatch(/do not start with (bash|grep|find)/i);
  });

  it('tells the model to use grep/find when the project has no index', () => {
    const hint = codeGraphIndexHint(tempWorkspace(false));
    expect(hint).toMatch(/no CodeGraph index/i);
    expect(hint).toMatch(/grep/);
    expect(hint).toMatch(/find/);
    expect(hint).not.toMatch(/call code_explore or code_search first/i);
  });
});
