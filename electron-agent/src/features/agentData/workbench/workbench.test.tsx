// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageHeader } from './PageHeader';
import { PageBanner } from './PageBanner';
import { MoreMenu } from './MoreMenu';
import { SplitPane } from './SplitPane';
import { StatusTag } from './StatusTag';

afterEach(cleanup);

describe('workbench components', () => {
  it('renders a page title, subtitle and actions', () => {
    render(<PageHeader title="任务" subtitle="2 个进行中" actions={<button>清理</button>} />);
    expect(screen.getByRole('heading', { name: '任务' })).toBeInTheDocument();
    expect(screen.getByText('2 个进行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清理' })).toBeInTheDocument();
  });

  it('merges several messages into one alert and hides when empty', () => {
    const { rerender, container } = render(<PageBanner type="error" items={[{ source: '知识库', message: 'a' }, { source: '页面', message: 'b' }]} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('知识库：a');
    expect(alert).toHaveTextContent('页面：b');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    rerender(<PageBanner type="error" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a labelled more menu and puts danger items after a divider', async () => {
    const onSelect = vi.fn();
    render(<MoreMenu label="知识库更多操作" items={[{ key: 'del', label: '删除知识库', danger: true }, { key: 'open', label: '打开存储位置' }]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库更多操作' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['打开存储位置', '删除知识库']);
    fireEvent.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith('del');
  });

  it('marks detail visibility for the narrow layout', () => {
    render(<SplitPane detailOpen side={<p>list</p>} main={<p>detail</p>} />);
    expect(screen.getByText('list').closest('[data-detail]')).toHaveAttribute('data-detail', 'true');
  });

  it('maps a domain status to a label', () => {
    render(<StatusTag domain="wiki" status="processing" />);
    expect(screen.getByText('处理中')).toBeInTheDocument();
  });
});
