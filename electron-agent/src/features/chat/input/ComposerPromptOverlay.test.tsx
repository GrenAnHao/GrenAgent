import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';

vi.mock('../../../lib/pi', () => ({
  extensionUiRespond: vi.fn(() => Promise.resolve()),
  pi: { resolvePermission: vi.fn() },
}));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: '/ws',
    store: {
      useStore: (selector: (s: { messages: unknown[] }) => unknown) => selector({ messages: [] }),
    },
  }),
  useAgentStore: () => ({
    useStore: { setState: () => undefined },
  }),
}));

import { ComposerPromptOverlay } from './ComposerPromptOverlay';
import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

afterEach(() => {
  cleanup();
  useInlineQuestionStore.setState({ byWorkspace: {} });
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
});

function renderOverlay() {
  const anchorRef = createRef<HTMLDivElement>();
  const view = render(
    <div data-chat-column="">
      <div
        ref={anchorRef}
        data-testid="composer-surface"
        style={{ width: 400, height: 80 }}
      />
      <ComposerPromptOverlay anchorRef={anchorRef} />
    </div>,
  );
  return view;
}

describe('ComposerPromptOverlay', () => {
  // 用 spyOn + mockRestore，不要直接改 prototype：直接改会永久污染本文件后续用例。
  // 不要用 vi.restoreAllMocks()，它会把上面 vi.mock 里的 vi.fn() 一并处理掉。
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-chat-column')) {
        return { top: 0, left: 0, width: 1000, height: 800, bottom: 800, right: 1000, x: 0, y: 0, toJSON() {} } as DOMRect;
      }
      return { top: 400, left: 20, width: 480, height: 80, bottom: 480, right: 500, x: 20, y: 400, toJSON() {} } as DOMRect;
    });
  });
  afterEach(() => {
    rectSpy?.mockRestore();
  });

  it('renders ask_user into the overlay', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
      mode: 'live',
    });
    renderOverlay();
    expect(screen.getByTestId('composer-prompt-overlay')).toHaveStyle({ width: '480px' });
    expect(screen.getByTestId('inline-question')).toBeTruthy();
    expect(screen.getByTestId('inline-question').getAttribute('data-full-width')).toBe('true');
  });

  it('repositions when an ancestor resizes even if the anchor width stays the same', async () => {
    const observed: Element[] = [];
    let callback: ResizeObserverCallback | undefined;
    const previous = globalThis.ResizeObserver;
    class TrackingResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callback = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TrackingResizeObserver);
    try {
      useInlineQuestionStore.getState().setRequest({
        workspace: '/ws',
        id: 'u1',
        data: {
          kind: 'questions',
          id: 'q1',
          questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
        },
        mode: 'live',
      });
      const anchorRef = createRef<HTMLDivElement>();
      const { container } = render(
        <div data-testid="column" data-chat-column="">
          <div ref={anchorRef} data-testid="composer-surface" style={{ width: 400, height: 80 }} />
          <ComposerPromptOverlay anchorRef={anchorRef} />
        </div>,
      );
      const overlay = screen.getByTestId('composer-prompt-overlay');
      expect(overlay).toHaveStyle({ left: '20px' });
      const column = container.querySelector('[data-testid="column"]');
      expect(column && observed.includes(column)).toBe(true);
      rectSpy.mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-chat-column')) {
          return { top: 0, left: 0, width: 1000, height: 800, bottom: 800, right: 1000, x: 0, y: 0, toJSON() {} } as DOMRect;
        }
        return { top: 400, left: 140, width: 480, height: 80, bottom: 480, right: 620, x: 140, y: 400, toJSON() {} } as DOMRect;
      });
      await act(async () => {
        callback?.([], {} as ResizeObserver);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(overlay).toHaveStyle({ left: '140px' });
    } finally {
      vi.stubGlobal('ResizeObserver', previous);
    }
  });

  it('keeps overlay extra content in the card scroll, not the overlay itself', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        allowExtra: true,
        questions: [
          { id: 'q1', title: '第一题', options: [{ id: 'a', label: '甲' }] },
          { id: 'q2', title: '第二题', options: [{ id: 'c', label: '丙' }] },
        ],
      },
      mode: 'live',
    });
    renderOverlay();
    fireEvent.click(screen.getByText('甲'));
    fireEvent.click(screen.getByTestId('inline-question-next'));
    const overlay = screen.getByTestId('composer-prompt-overlay');
    const scroll = screen.getByTestId('inline-question-scroll');
    expect(overlay.contains(scroll)).toBe(true);
    expect(scroll.contains(screen.getByTestId('inline-question-extra'))).toBe(true);
    expect(scroll.contains(screen.getByTestId('inline-question-submit'))).toBe(false);
    expect(getComputedStyle(overlay).overflowY).not.toBe('auto');
  });

  it('keeps the question card inside the session column', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
      mode: 'live',
    });
    renderOverlay();
    const overlay = screen.getByTestId('composer-prompt-overlay');
    const surface = screen.getByTestId('composer-surface');
    expect(surface.contains(overlay)).toBe(false);
    expect(overlay.parentElement?.hasAttribute('data-chat-column')).toBe(true);
    expect(overlay.parentElement).not.toBe(document.body);
  });

  it('drops the card when the session column is not on screen', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
      mode: 'live',
    });
    rectSpy.mockReturnValue({
      top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON() {},
    } as DOMRect);
    renderOverlay();
    expect(screen.queryByTestId('composer-prompt-overlay')).toBeNull();
  });

  it('renders overlay select and skips approval', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    renderOverlay();
    expect(screen.getByTestId('composer-prompt-overlay')).toBeTruthy();
    expect(screen.getByTestId('prompt-request-select')).toBeTruthy();
    expect(screen.getByTestId('prompt-request-select').getAttribute('data-full-width')).toBe('true');

    cleanup();
    useUiPromptStore.getState().clear('/ws', 's1');
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'a1', method: 'select', options: ['允许', '拒绝'] },
    });
    renderOverlay();
    expect(screen.queryByTestId('composer-prompt-overlay')).toBeNull();
  });

  it('prefers ask_user when both stores have values', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
      mode: 'live',
    });
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    renderOverlay();
    expect(screen.getByTestId('inline-question')).toBeTruthy();
    expect(screen.queryByTestId('prompt-request-select')).toBeNull();
  });

  it('does not close on Escape or click outside', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    renderOverlay();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId('composer-prompt-overlay')).toBeTruthy();
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.request.id).toBe('s1');
  });

  it('renders nothing when no request is pending', () => {
    renderOverlay();
    expect(screen.queryByTestId('composer-prompt-overlay')).toBeNull();
  });
});
