import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directionOfMouseButton, registerNavTarget, resetNavBusForTest, routeNavigation, triggerNavigation } from './fileNavBus';

function mountExplorer(options: { hover?: boolean; shown?: boolean } = {}) {
  const element = document.createElement('div');
  const inner = document.createElement('button');
  element.append(inner);
  document.body.append(element);
  element.matches = ((selector: string) => (selector === ':hover' ? options.hover === true : false)) as never;
  element.getClientRects = (() => (options.shown === false ? [] : [{}])) as never;
  const go = vi.fn();
  const dispose = registerNavTarget({ element: () => element, go });
  return { element, inner, go, dispose };
}

beforeEach(resetNavBusForTest);
afterEach(() => {
  document.body.innerHTML = '';
});

describe('directionOfMouseButton', () => {
  it('DOM 约定：3 后退、4 前进，其余不是', () => {
    expect(directionOfMouseButton(3)).toBe('back');
    expect(directionOfMouseButton(4)).toBe('forward');
    for (const button of [0, 1, 2, 5]) expect(directionOfMouseButton(button)).toBeNull();
  });
});

describe('routeNavigation（app-command 没有鼠标位置，按悬停 / 焦点认领）', () => {
  it('鼠标悬停的文件浏览器认领', () => {
    const a = mountExplorer();
    const b = mountExplorer({ hover: true });
    expect(routeNavigation('back', 1000)).toBe(true);
    expect(b.go).toHaveBeenCalledWith('back');
    expect(a.go).not.toHaveBeenCalled();
  });

  it('没有悬停时按键盘焦点认领', () => {
    const a = mountExplorer();
    const b = mountExplorer();
    b.inner.focus();
    expect(routeNavigation('forward', 1000)).toBe(true);
    expect(b.go).toHaveBeenCalledWith('forward');
    expect(a.go).not.toHaveBeenCalled();
  });

  it('藏起来的（别的会话 / 别的标签里的）不认领，没人认领返回 false', () => {
    const hidden = mountExplorer({ hover: true, shown: false });
    expect(routeNavigation('back', 1000)).toBe(false);
    expect(hidden.go).not.toHaveBeenCalled();
  });

  it('卸载后不再认领', () => {
    const a = mountExplorer({ hover: true });
    a.dispose();
    expect(routeNavigation('back', 1000)).toBe(false);
  });
});

describe('同一次侧键的两条通路去重', () => {
  it('同方向 250ms 内只认一次，之后可以再按；方向不同不受影响', () => {
    const a = mountExplorer({ hover: true });
    const target = { element: () => a.element, go: a.go };
    expect(triggerNavigation(target, 'back', 1000)).toBe(true);
    expect(triggerNavigation(target, 'back', 1100)).toBe(false);
    expect(triggerNavigation(target, 'forward', 1100)).toBe(true);
    expect(triggerNavigation(target, 'back', 1300)).toBe(true);
    expect(a.go).toHaveBeenCalledTimes(3);
  });

  it('渲染进程先收到 button 3，随后到达的 app-command 被吞掉', () => {
    const a = mountExplorer({ hover: true });
    triggerNavigation({ element: () => a.element, go: a.go }, 'back', 1000);
    routeNavigation('back', 1050);
    expect(a.go).toHaveBeenCalledTimes(1);
  });
});
