// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../dock/browser/openBrowserPopupTab', () => ({ openBrowserPopupTab: vi.fn() }));
vi.mock('./input/editor/promptCommandCache', () => ({
  getCachedPromptCommands: () => [
    { name: 'refactor', description: '', body: '', params: [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }], path: '' },
  ],
}));

import { buildCommandBlock } from '@extensions/prompt-commands/syntax';
import { parseMessageTags, renderMessageTags } from './messageTags';

const block = buildCommandBlock('refactor', [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }], '请把 src/a.ts 重构');

describe('command 段', () => {
  it('<command> 块整块变成胶囊，正文不出现，补充正文照常', () => {
    render(<span>{renderMessageTags(`${block}\n\n顺便看看 @src/b.ts`)}</span>);
    expect(screen.getByTestId('command-pill')).toHaveAttribute('data-command', 'refactor');
    expect(screen.queryByText(/请把 src\/a\.ts 重构/)).not.toBeInTheDocument();
    expect(screen.getByText(/顺便看看/)).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('块后的空行压成一个空格，胶囊和补充正文之间只隔一个空格', () => {
    const segments = parseMessageTags(`${block}\n\n顺便看看`);
    expect(segments).toEqual([
      { type: 'command', name: 'refactor', args: [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: '顺便看看' },
    ]);
  });

  it('块后没有补充正文时不追加空格段', () => {
    expect(parseMessageTags(`${block}\n`)).toEqual([
      { type: 'command', name: 'refactor', args: [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }] },
    ]);
  });

  it('刚发出去的调用文本也还原成胶囊，空参数显示默认值', () => {
    expect(parseMessageTags('/refactor "src/a.ts" "" 顺便')).toEqual([
      { type: 'command', name: 'refactor', args: [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }] },
      { type: 'text', text: ' 顺便' },
    ]);
  });

  it('不认识的命令和 args 坏掉的块按普通文本显示', () => {
    expect(parseMessageTags('/unknown "a"')).toEqual([{ type: 'text', text: '/unknown "a"' }]);
    const broken = '<command name="x" args="oops">\nbody\n</command>';
    expect(parseMessageTags(broken)).toEqual([{ type: 'text', text: broken }]);
  });
});
