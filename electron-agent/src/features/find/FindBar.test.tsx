import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindBar } from './FindBar';
import { closeFind, openFind } from './findActions';
import { useFindStore } from './findStore';

const SCOPE = 'chat';

beforeEach(() => {
  useFindStore.setState({ scopes: {} });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const scope = () => useFindStore.getState().scopes[SCOPE];
const setStatus = (total: number, current: number) => act(() => useFindStore.getState().setStatus(SCOPE, { total, current }));
const input = () => screen.getByTestId('find-input') as HTMLInputElement;

function mount() {
  act(() => useFindStore.getState().open(SCOPE));
  return render(<FindBar scope={SCOPE} placeholder="在会话中查找" />);
}

describe('FindBar', () => {
  it('打开时焦点进输入框', () => {
    mount();
    expect(document.activeElement).toBe(input());
  });

  it('再次触发打开：重新聚焦并全选，不改查询', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'login' } });
    (document.body as HTMLElement).focus();
    input().blur();
    act(() => useFindStore.getState().open(SCOPE));
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(5);
    expect(scope().query).toBe('login');
  });

  it('输入为空：不显示计数，上一个 / 下一个置灰', () => {
    mount();
    expect(screen.getByTestId('find-count').textContent).toBe('');
    expect((screen.getByTestId('find-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('find-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('有结果：显示「当前 / 总数」，跳转可用', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'login' } });
    setStatus(5, 2);
    expect(screen.getByTestId('find-count').textContent).toBe('2 / 5');
    expect((screen.getByTestId('find-next') as HTMLButtonElement).disabled).toBe(false);
    expect(input().parentElement?.getAttribute('data-empty-result')).toBeNull();
  });

  it('无结果：明确写「无结果」、输入框标红、跳转置灰', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'zzz' } });
    setStatus(0, 0);
    expect(screen.getByTestId('find-count').textContent).toBe('无结果');
    expect(screen.getByTestId('find-count').getAttribute('data-empty-result')).toBe('true');
    expect(input().parentElement?.getAttribute('data-empty-result')).toBe('true');
    expect((screen.getByTestId('find-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('find-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Enter 下一个，Shift+Enter 上一个；没有结果时不发请求', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'login' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(scope().nav.nonce).toBe(0);
    setStatus(3, 1);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(scope().nav).toEqual({ dir: 'next', nonce: 1 });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(scope().nav).toEqual({ dir: 'prev', nonce: 2 });
  });

  it('输入法组字时 Enter 不当成跳转', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'login' } });
    setStatus(3, 1);
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(scope().nav.nonce).toBe(0);
  });

  it('按钮：上一个、下一个、关闭', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'login' } });
    setStatus(3, 1);
    fireEvent.click(screen.getByTestId('find-next'));
    fireEvent.click(screen.getByTestId('find-prev'));
    expect(scope().nav).toEqual({ dir: 'prev', nonce: 2 });
    fireEvent.click(screen.getByTestId('find-close'));
    expect(scope().open).toBe(false);
  });

  it('Esc 关闭，并且不再往上冒（别处的 Esc 不跟着触发）', () => {
    const outer = vi.fn();
    act(() => useFindStore.getState().open(SCOPE));
    render(
      <div onKeyDown={outer}>
        <FindBar scope={SCOPE} placeholder="在会话中查找" />
      </div>,
    );
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(scope().open).toBe(false);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('打开 / 关闭的焦点归属', () => {
  it('关闭后焦点回到打开前的元素', () => {
    const composer = document.createElement('div');
    composer.contentEditable = 'true';
    composer.tabIndex = 0;
    document.body.append(composer);
    composer.focus();
    const root = document.createElement('div');
    root.dataset.findScope = SCOPE;
    document.body.append(root);

    openFind(SCOPE, root);
    expect(scope().open).toBe(true);
    render(<FindBar scope={SCOPE} placeholder="在会话中查找" />);
    expect(document.activeElement).toBe(input());

    closeFind(SCOPE, root);
    expect(scope().open).toBe(false);
    expect(document.activeElement).toBe(composer);
  });

  it('打开前的元素已经不在：落到范围里的输入位置', () => {
    const root = document.createElement('div');
    root.dataset.findScope = SCOPE;
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.tabIndex = 0;
    root.append(composer);
    const gone = document.createElement('button');
    root.append(gone);
    document.body.append(root);
    gone.focus();

    openFind(SCOPE, root);
    gone.remove();
    closeFind(SCOPE, root);
    expect(document.activeElement).toBe(composer);
  });

  it('选中了一段单行文字：打开时预填它', () => {
    const root = document.createElement('div');
    root.dataset.findScope = SCOPE;
    root.innerHTML = '<p id="p">hello login world</p>';
    document.body.append(root);
    const text = root.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    openFind(SCOPE, root);
    expect(scope().query).toBe('login');
  });

  it('已经打开时再打开不覆盖查询', () => {
    const root = document.createElement('div');
    document.body.append(root);
    openFind(SCOPE, root);
    useFindStore.getState().setQuery(SCOPE, 'abc');
    openFind(SCOPE, root);
    expect(scope().query).toBe('abc');
    expect(scope().focusNonce).toBe(2);
  });
});
