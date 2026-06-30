import { describe, expect, it } from 'vitest';
import { parseAnsi, parseCodegraphStatus, stripAnsi } from './ansi';

const ESC = '\u001b';

// A realistic `codegraph status` payload, complete with the SGR codes the CLI
// emits over a pipe (bold headers, cyan field labels, reset).
const SAMPLE = [
  `${ESC}[1mCodeGraph Status${ESC}[0m`,
  `  ${ESC}[36mProject:${ESC}[0m D:/System Dir/Downloads/lobehub`,
  '',
  `  ${ESC}[1mIndex Statistics:${ESC}[0m`,
  '    Files:    62',
  '    Nodes:    506',
  '    Edges:    440',
  '    DB Size:  4.31 MB',
  '    Backend:  mode:sqlite - built-in (full WAL)',
  '    Journal:  wal',
].join('\n');

describe('stripAnsi', () => {
  it('removes SGR escape sequences but keeps the text', () => {
    expect(stripAnsi(`${ESC}[1m${ESC}[36mHello${ESC}[0m world`)).toBe('Hello world');
  });

  it('drops non-colour CSI sequences (cursor moves, clears)', () => {
    expect(stripAnsi(`a${ESC}[2Kb${ESC}[1;1Hc`)).toBe('abc');
  });

  it('is a no-op on plain text', () => {
    expect(stripAnsi('just text\nline two')).toBe('just text\nline two');
  });
});

describe('parseAnsi', () => {
  it('returns a single unstyled segment for plain text', () => {
    expect(parseAnsi('plain')).toEqual([{ text: 'plain', bold: false, dim: false, color: undefined }]);
  });

  it('tracks bold + colour and resets them', () => {
    const segs = parseAnsi(`${ESC}[1m${ESC}[31mERR${ESC}[0m ok`);
    const err = segs.find((s) => s.text === 'ERR');
    expect(err?.bold).toBe(true);
    expect(err?.color).toBe('#e06c75');
    const ok = segs.find((s) => s.text === ' ok');
    expect(ok?.bold).toBe(false);
    expect(ok?.color).toBeUndefined();
  });

  it('reassembles to the stripped text', () => {
    expect(
      parseAnsi(SAMPLE)
        .map((s) => s.text)
        .join(''),
    ).toBe(stripAnsi(SAMPLE));
  });
});

describe('parseCodegraphStatus', () => {
  it('extracts metrics from the normalized status JSON', () => {
    const r = parseCodegraphStatus(
      JSON.stringify({
        indexed: true,
        project: 'D-OneDrive-x',
        nodes: 506,
        edges: 440,
        sizeBytes: 4_520_000,
        rootPath: 'D:/System Dir/Downloads/lobehub',
      }),
    );
    expect(r.indexed).toBe(true);
    expect(r.stats).toContainEqual({ label: 'Nodes', value: '506' });
    expect(r.stats).toContainEqual({ label: 'Edges', value: '440' });
    expect(r.stats.find((s) => s.label === 'DB Size')).toBeTruthy();
    expect(r.project).toBe('D-OneDrive-x');
    expect(r.details).toContainEqual({ label: 'Root', value: 'D:/System Dir/Downloads/lobehub' });
  });

  it('parses the index_repository result shape (status:indexed)', () => {
    const r = parseCodegraphStatus(JSON.stringify({ project: 'D-x', status: 'indexed', nodes: 231, edges: 546 }));
    expect(r.indexed).toBe(true);
    expect(r.stats).toContainEqual({ label: 'Nodes', value: '231' });
  });

  it('degrades gracefully for a not-indexed project', () => {
    const r = parseCodegraphStatus(JSON.stringify({ indexed: false, project: 'D-x' }));
    expect(r.indexed).toBe(false);
    expect(r.stats).toEqual([]);
  });

  it('degrades gracefully for error / non-JSON output', () => {
    const r = parseCodegraphStatus('codebase-memory ["list_projects"] exited (1): boom');
    expect(r.indexed).toBe(false);
    expect(r.stats).toEqual([]);
  });
});
