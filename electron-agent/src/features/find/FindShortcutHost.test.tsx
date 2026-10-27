import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFindScope } from './findActions';
import { FindShortcutHost } from './FindShortcutHost';
import { useFindStore } from './findStore';

const disposers: Array<() => void> = [];

function scope(id: string, html = '<input id="in" /><p id="text">hello</p>', canFind = true) {
  const root = document.createElement('div');
  root.dataset.findScope = id;
  root.innerHTML = html;
  root.getClientRects = (() => [{}]) as never;
  document.body.append(root);
  disposers.push(registerFindScope(id, () => canFind));
  return root;
}

/** 在 target 上按 Ctrl+F；返回事件（看 defaultPrevented）。 */
function press(target: Element | Document, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useFindStore.setState({ scopes: {} });
  render(<FindShortcutHost />);
});
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = '';
});

const opened = (id: string) => useFindStore.getState().scopes[id]?.open === true;

describe('FindShortcutHost：Ctrl+F 的归属', () => {
  it('焦点在会话里（含输入框）：打开会话查找并拦下默认行为', () => {
    const root = scope('chat');
    const event = press(root.querySelector('#in')!);
    expect(opened('chat')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('先于别的 document 级监听（侧栏搜索框的 Ctrl+F）：被拦下就不再往下传', () => {
    const root = scope('chat');
    const sidebar = vi.fn();
    document.addEventListener('keydown', sidebar);
    press(root.querySelector('#in')!);
    expect(sidebar).not.toHaveBeenCalled();
    document.removeEventListener('keydown', sidebar);
  });

  it('焦点在范围之外（侧栏等）：不拦，原有行为照旧', () => {
    scope('chat');
    const outside = document.createElement('input');
    document.body.append(outside);
    const sidebar = vi.fn();
    document.addEventListener('keydown', sidebar);
    const event = press(outside);
    expect(opened('chat')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(sidebar).toHaveBeenCalled();
    document.removeEventListener('keydown', sidebar);
  });

  it('焦点在 body（刚点了消息文字）：按最后一次点击所在的范围认领', () => {
    const root = scope('chat');
    root.querySelector('#text')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const event = press(document.body);
    expect(opened('chat')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('最后一次点击在范围之外（点了侧栏）：body 上的 Ctrl+F 不拦', () => {
    const root = scope('chat');
    root.querySelector('#text')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const outside = document.createElement('div');
    document.body.append(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(press(document.body).defaultPrevented).toBe(false);
    expect(opened('chat')).toBe(false);
  });

  it('文件标签：范围各自独立，只有能查的才拦（没打开文本文件不拦）', () => {
    const file = scope('file-1');
    const empty = scope('file-2', '<p>x</p>', false);
    expect(press(empty.querySelector('p')!).defaultPrevented).toBe(false);
    expect(opened('file-2')).toBe(false);
    expect(press(file.querySelector('p')!).defaultPrevented).toBe(true);
    expect(opened('file-1')).toBe(true);
    expect(opened('chat')).toBe(false);
  });

  it('弹窗里不拦', () => {
    const root = scope('chat');
    const dialog = document.createElement('div');
    dialog.className = 'ant-modal';
    dialog.innerHTML = '<input id="m" />';
    root.append(dialog);
    expect(press(dialog.querySelector('#m')!).defaultPrevented).toBe(false);
    expect(opened('chat')).toBe(false);
  });

  it('不是单纯的 Ctrl+F 不拦：带 Shift / Alt、别的键、macOS 的 Ctrl', () => {
    const root = scope('chat');
    const target = root.querySelector('#in')!;
    expect(press(target, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(target, { altKey: true }).defaultPrevented).toBe(false);
    expect(press(target, { key: 'g' }).defaultPrevented).toBe(false);
    expect(press(target, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(opened('chat')).toBe(false);
  });

  it('已经打开时再按：只重新聚焦，不重置查询', () => {
    const root = scope('chat');
    press(root.querySelector('#in')!);
    useFindStore.getState().setQuery('chat', 'abc');
    press(root.querySelector('#in')!);
    expect(useFindStore.getState().scopes.chat.query).toBe('abc');
    expect(useFindStore.getState().scopes.chat.focusNonce).toBe(2);
  });
});
