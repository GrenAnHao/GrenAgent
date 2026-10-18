// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRelations, CodeResultContent, codeRequestError } from './CodeRelations';
import type { CodeResultView } from './codeResult';
import { agentDataApi } from '../../lib/agentData';
vi.mock('../../lib/agentData', () => ({ agentDataApi: { code: { call: vi.fn() } } }));

function rowsResult(count: number, raw: unknown = {}): CodeResultView {
  return { rows: Array.from({ length: count }, (_, index) => ({ file: `src/file-${index}.ts` })), raw, isError: false, recognition: 'rows' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
describe('CodeRelations', () => {
  it('uses the stable SDK node ID while showing the human symbol name', async () => {
    render(<CodeRelations workspace="D:/repo" symbol="parse" nodeId="function:exact-overload" file="src/a.ts" visible />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/repo', tool: 'codegraph_callers', args: { symbol: 'function:exact-overload', file: 'src/a.ts' } }));
    expect(screen.getByText(/当前符号：parse/)).toBeTruthy();
  });
  it('refreshes the visible relation when an indexing task finishes, but waits while hidden', async () => {
    vi.mocked(agentDataApi.code.call).mockResolvedValueOnce({ structuredContent: [{ symbol: 'beforeSync' }] });
    const { rerender } = render(<CodeRelations workspace="D:/repo" symbol="parse" file="a.ts" visible reloadVersion={0} />);
    await screen.findByText('beforeSync');
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ structuredContent: [{ symbol: 'afterSync' }] });
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" file="a.ts" visible reloadVersion={1} />);
    await screen.findByText('afterSync');
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(2);
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" file="a.ts" visible={false} reloadVersion={2} />);
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(2);
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" file="a.ts" visible reloadVersion={2} />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledTimes(3));
  });

  beforeEach(() => { vi.resetAllMocks(); vi.mocked(agentDataApi.code.call).mockResolvedValue({ structuredContent: [] }); });
  afterEach(cleanup);

  it.each(['CodeGraph index not found', 'CodeGraph index missing'])('does not mislabel a missing index as a missing CLI: %s', (message) => {
    expect(codeRequestError(new Error(message))).toContain('索引缺失');
    expect(codeRequestError(new Error(message))).not.toContain('CLI 不可用');
  });

  it('does not guess a missing CLI from a missing queried symbol', () => {
    expect(codeRequestError(new Error('CodeGraph query: symbol missing'))).toBe('查询失败：CodeGraph query: symbol missing');
  });

  it('uses the selected relation tool with the symbol and its disambiguating file', async () => {
    render(<CodeRelations workspace="D:/repo" symbol="parse" file="src/a.ts" visible />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/repo', tool: 'codegraph_callers', args: { symbol: 'parse', file: 'src/a.ts' } }));
    fireEvent.click(screen.getByRole('radio', { name: '被调用者' }));
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/repo', tool: 'codegraph_callees', args: { symbol: 'parse', file: 'src/a.ts' } }));
    fireEvent.click(screen.getByRole('radio', { name: '影响' }));
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/repo', tool: 'codegraph_impact', args: { symbol: 'parse', file: 'src/a.ts' } }));
  });

  it('immediately clears old-tab content and ignores a slower old response', async () => {
    const old = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockReturnValueOnce(old.promise).mockResolvedValue({ structuredContent: [{ symbol: 'callee' }] });
    render(<CodeRelations workspace="D:/repo" symbol="parse" visible />);
    fireEvent.click(screen.getByRole('radio', { name: '被调用者' }));
    await screen.findByText('callee');
    await act(async () => { old.resolve({ structuredContent: [{ file: 'old.ts' }] }); });
    expect(screen.queryByText('old.ts')).toBeNull();
    expect(screen.getByText('未提供文件位置')).toBeTruthy();
    expect(screen.getByText('未提供行号')).toBeTruthy();
  });

  it('retains explicit MCP errors, unknown objects and readable text rather than showing an empty result', async () => {
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ isError: true, structuredContent: { nodes: ['unrecognized'] }, content: [{ type: 'text', text: 'partial connection failure' }] });
    render(<CodeRelations workspace="D:/repo" symbol="parse" visible />);
    expect((await screen.findByRole('alert')).textContent).toContain('partial connection failure');
    expect(screen.getByText('原始结果')).toBeTruthy();
    expect(screen.queryByText('没有匹配结果')).toBeNull();
    expect(document.querySelector('svg[data-graph]')).toBeNull();
  });

  it('pauses while hidden and rejects hidden responses before refreshing once on return', async () => {
    const { rerender } = render(<CodeRelations workspace="D:/repo" symbol="parse" visible={false} />);
    expect(agentDataApi.code.call).not.toHaveBeenCalled();
    const old = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockReturnValueOnce(old.promise).mockResolvedValue({ content: [{ type: 'text', text: 'fresh text' }] });
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" visible />);
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" visible={false} />);
    await act(async () => { old.resolve({ content: [{ type: 'text', text: 'hidden text' }] }); });
    expect(screen.queryByText('hidden text')).toBeNull();
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" visible />);
    await screen.findByText('fresh text');
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(2);
  });

  it('clears old-symbol results immediately and does not synthesize a file argument', async () => {
    vi.mocked(agentDataApi.code.call).mockResolvedValueOnce({ structuredContent: [{ symbol: 'alpha' }] });
    const { rerender } = render(<CodeRelations workspace="D:/repo" symbol="a" file="a.ts" visible />);
    await screen.findByText('alpha');
    const pending = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockReturnValue(pending.promise);
    rerender(<CodeRelations workspace="D:/other" symbol="b" visible />);
    expect(screen.queryByText('alpha')).toBeNull();
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/other', tool: 'codegraph_callers', args: { symbol: 'b' } }));
  });

  describe('CodeResultContent paging', () => {
    const select = vi.fn();
    const rendered = () => document.querySelectorAll('[aria-label="代码文件列表"] button').length;

    it('renders only the first page of a long result and appends one page per click', () => {
      render(<CodeResultContent result={rowsResult(250)} tool="codegraph_files" onSelect={select} />);
      expect(rendered() - 1).toBe(100);
      expect(screen.queryByText('src/file-100.ts')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 150 项）' }));
      expect(rendered() - 1).toBe(200);
      expect(screen.getByText('src/file-199.ts')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 50 项）' }));
      expect(rendered()).toBe(250);
      expect(screen.queryByRole('button', { name: /显示更多/ })).toBeNull();
    });

    it('shows no load-more button when the result fits in one page', () => {
      render(<CodeResultContent result={rowsResult(100)} tool="codegraph_files" onSelect={select} />);
      expect(rendered()).toBe(100);
      expect(screen.queryByRole('button', { name: /显示更多/ })).toBeNull();
    });

    it('starts over from the first page when the caller remounts it with a new key', () => {
      const { rerender } = render(<CodeResultContent key="a" result={rowsResult(250)} onSelect={select} />);
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      expect(screen.getByText('src/file-150.ts')).toBeTruthy();
      rerender(<CodeResultContent key="b" result={rowsResult(250)} onSelect={select} />);
      expect(screen.queryByText('src/file-150.ts')).toBeNull();
      expect(screen.getByRole('button', { name: '显示更多（还有 150 项）' })).toBeTruthy();
    });

    it('keeps the expanded pages when the same query refreshes into a new result object', () => {
      const { rerender } = render(<CodeResultContent key="a" result={rowsResult(250)} onSelect={select} />);
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      rerender(<CodeResultContent key="a" result={rowsResult(250)} onSelect={select} />);
      expect(screen.getByText('src/file-150.ts')).toBeTruthy();
    });
  });

  describe('CodeResultContent server paging', () => {
    const select = vi.fn();
    const listed = () => document.querySelectorAll('[aria-label="代码文件列表"] [aria-pressed]').length;

    it('shows every loaded row and asks the caller for the next page instead of slicing locally', () => {
      const onLoad = vi.fn();
      render(<CodeResultContent result={rowsResult(250)} tool="codegraph_files" onSelect={select} more={{ remaining: 750, loading: false, onLoad }} />);
      expect(listed()).toBe(250);
      fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 750 项）' }));
      expect(onLoad).toHaveBeenCalledTimes(1);
    });

    it('keeps showing every loaded row, with no button, once the last page has arrived', () => {
      render(<CodeResultContent result={rowsResult(250)} tool="codegraph_files" onSelect={select} more={{ remaining: 0, loading: false, onLoad: vi.fn() }} />);
      expect(listed()).toBe(250);
      expect(screen.queryByRole('button', { name: /显示更多/ })).toBeNull();
    });

    it('shows a busy button that ignores clicks but is not disabled, so a keyboard user keeps their focus on it', () => {
      const onLoad = vi.fn();
      render(<CodeResultContent result={rowsResult(5)} tool="codegraph_files" onSelect={select} more={{ remaining: 10, loading: true, onLoad }} />);
      const button = screen.getByRole('button', { name: '正在加载…' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      button.focus();
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      expect(onLoad).not.toHaveBeenCalled();
    });
  });

  describe('CodeResultContent raw result', () => {
    const toggle = (open: boolean) => {
      const details = screen.getByText('原始结果').closest('details')!;
      details.open = open;
      fireEvent(details, new Event('toggle'));
    };

    it('does not serialize the raw payload until the details are opened', () => {
      const raw = { toJSON: vi.fn(() => ({ rows: 'huge' })) };
      render(<CodeResultContent result={rowsResult(3, raw)} />);
      expect(raw.toJSON).not.toHaveBeenCalled();
      expect(document.querySelector('details pre')).toBeNull();
      toggle(true);
      expect(raw.toJSON).toHaveBeenCalled();
      expect(document.querySelector('details pre')?.textContent).toContain('huge');
      toggle(false);
      expect(document.querySelector('details pre')).toBeNull();
    });

    it('truncates an oversized raw payload and says how much was cut', () => {
      render(<CodeResultContent result={rowsResult(1, { blob: 'x'.repeat(250_000) })} />);
      toggle(true);
      expect(document.querySelector('details pre')!.textContent!.length).toBe(200_000);
      expect(screen.getByText(/已截断：显示前 200000 个字符，共 \d+ 个字符/)).toBeTruthy();
    });
  });

  it('preserves previous rows when the same relation refresh returns an MCP error', async () => {
    vi.mocked(agentDataApi.code.call).mockResolvedValueOnce({ structuredContent: [{ file: 'caller.ts', symbol: 'caller' }] });
    const { rerender } = render(<CodeRelations workspace="D:/repo" symbol="parse" visible reloadVersion={0} />);
    await screen.findByText('caller');
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'connection lost' }] });
    rerender(<CodeRelations workspace="D:/repo" symbol="parse" visible reloadVersion={1} />);
    await screen.findByRole('alert');
    expect(screen.getByText('caller')).toBeTruthy();
    expect(screen.getByText(/保留上次/)).toBeTruthy();
  });
});
