import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { AttachmentCard } from './AttachmentCard';
import type { AttachmentBlock } from './attachment';

afterEach(cleanup);

const renderCard = (block: AttachmentBlock) =>
  render(
    <ThemeProvider>
      <AttachmentCard block={block} />
    </ThemeProvider>,
  );

describe('AttachmentCard', () => {
  it('file 卡显示文件名与行数, 折叠态不显示内容', () => {
    renderCard({ attType: 'file', path: 'src/config.ts', lines: 42, content: 'secret' });
    expect(screen.getByText('config.ts')).toBeTruthy();
    expect(screen.getByText('42 行')).toBeTruthy();
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('text 卡显示粘贴文本与行数字数', () => {
    renderCard({ attType: 'text', lines: 120, chars: 3210, content: 'log' });
    expect(screen.getByText('粘贴文本')).toBeTruthy();
    expect(screen.getByText('120 行 · 3.2k 字')).toBeTruthy();
  });

  it('点击头部展开后显示内容', () => {
    renderCard({ attType: 'file', path: 'a.ts', lines: 1, content: 'const x = 1' });
    fireEvent.click(screen.getByText('a.ts'));
    expect(screen.getByText('const x = 1')).toBeTruthy();
  });
});
