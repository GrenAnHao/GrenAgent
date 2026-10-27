import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useFileHistory } from './useFileHistory';

/** 模拟 useOpenFile：open 立刻把当前路径换掉；cancelNext 模拟用户在未保存询问里点了「取消」。 */
function setup() {
  const control = { cancelNext: false };
  const hook = renderHook(() => {
    const [path, setPath] = useState<string | null>(null);
    const open = async (next: string) => {
      if (control.cancelNext) {
        control.cancelNext = false;
        return false;
      }
      setPath(next);
      return true;
    };
    return { path, open, history: useFileHistory(path, open) };
  });
  const openFile = (p: string) => act(async () => void (await hook.result.current.open(p)));
  const flags = () => [hook.result.current.history.canBack, hook.result.current.history.canForward];
  return { hook, control, openFile, flags };
}

describe('useFileHistory', () => {
  it('依次打开三个文件：可以后退、不能前进；后退再前进回到原处', async () => {
    const { hook, openFile, flags } = setup();
    expect(flags()).toEqual([false, false]);
    await openFile('/a');
    expect(flags()).toEqual([false, false]);
    await openFile('/b');
    await openFile('/c');
    expect(flags()).toEqual([true, false]);

    await act(async () => hook.result.current.history.back());
    expect(hook.result.current.path).toBe('/b');
    expect(flags()).toEqual([true, true]);
    await act(async () => hook.result.current.history.back());
    expect(hook.result.current.path).toBe('/a');
    expect(flags()).toEqual([false, true]);
    await act(async () => hook.result.current.history.forward());
    expect(hook.result.current.path).toBe('/b');
  });

  it('在中间打开新文件：前进栈被截掉', async () => {
    const { hook, openFile, flags } = setup();
    await openFile('/a');
    await openFile('/b');
    await openFile('/c');
    await act(async () => hook.result.current.history.back());
    await act(async () => hook.result.current.history.back());
    await openFile('/d');
    expect(flags()).toEqual([true, false]);
    await act(async () => hook.result.current.history.back());
    expect(hook.result.current.path).toBe('/a');
  });

  it('后退时在未保存询问里取消：没有切过去，指针不动', async () => {
    const { hook, control, openFile, flags } = setup();
    await openFile('/a');
    await openFile('/b');
    control.cancelNext = true;
    await act(async () => hook.result.current.history.back());
    expect(hook.result.current.path).toBe('/b');
    expect(flags()).toEqual([true, false]);
    await act(async () => hook.result.current.history.back());
    expect(hook.result.current.path).toBe('/a');
  });

  it('同一个文件重复打开不重复记录；路径写法不同（大小写 / 斜杠）算同一个', async () => {
    const { openFile, flags } = setup();
    await openFile('C:\\repo\\A.md');
    await openFile('c:/repo/a.md');
    expect(flags()).toEqual([false, false]);
  });
});
