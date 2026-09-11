import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';
import { UserMessage } from './UserMessage';

afterEach(cleanup);

const renderMsg = (text: string) =>
  render(
    <App>
      <ThemeProvider>
        <UserMessage text={text} />
      </ThemeProvider>
    </App>,
  );

describe('UserMessage', () => {
  it('把 pi:attachment 标记渲染成附件卡片, 正文进气泡', () => {
    const text =
      '看这个\n\n<pi:attachment type="file" path="src/config.ts" lines="42">\nconst x = 1\n</pi:attachment>';
    renderMsg(text);
    expect(screen.getByText('看这个')).toBeTruthy();
    expect(screen.getByText('config.ts')).toBeTruthy();
    expect(screen.getByText('42 行')).toBeTruthy();
    // 折叠态不直接显示文件内容
    expect(screen.queryByText('const x = 1')).toBeNull();
  });

  it('无标记的纯文本按原样渲染', () => {
    renderMsg('hello world');
    expect(screen.getByText('hello world')).toBeTruthy();
  });

  it('memory_extract 提示走预格式化，JSON 键单独成行', () => {
    const text = [
      'Extract durable memory as strict JSON. Return JSON only.',
      'Task kind: memory_extract',
      'Input: {"delta":"user: 你是什么模型?"}',
    ].join('\n');
    renderMsg(text);
    const pre = screen.getByTestId('structured-pre');
    expect(pre.textContent).toContain('Task kind: memory_extract');
    expect(pre.textContent).toContain('"delta"');
    expect(pre.textContent).toContain('你是什么模型?');
  });

  it('有文本时渲染复制按钮与更多菜单', () => {
    render(
      <App>
        <ThemeProvider>
          <UserMessage text="继续搜索上周的" />
        </ThemeProvider>
      </App>,
    );
    const actionBar = within(screen.getByTestId('message-action-bar'));
    expect(actionBar.getByTestId('msg-action-bar-copy')).toBeTruthy();
    expect(actionBar.getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('纯图片无文本时不渲染操作栏', () => {
    const { container } = render(
      <App>
        <ThemeProvider>
          <UserMessage text="" images={[{ mimeType: 'image/png', data: 'AAAA' }]} />
        </ThemeProvider>
      </App>,
    );
    expect(container.querySelector('.chat-actions')).toBeNull();
  });
});
