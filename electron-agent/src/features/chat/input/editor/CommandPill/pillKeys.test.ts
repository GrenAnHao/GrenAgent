import { describe, expect, it } from 'vitest';
import { pillKeyAction, type PillKeyInput } from './pillKeys';

const base: PillKeyInput = { key: 'a', shift: false, composing: false, value: 'abc', selectionStart: 1, selectionEnd: 1, index: 0, count: 2 };
const at = (patch: Partial<PillKeyInput>) => pillKeyAction({ ...base, ...patch });

describe('pillKeyAction', () => {
  it('Tab 前进，最后一个参数跳出到胶囊后', () => {
    expect(at({ key: 'Tab' })).toEqual({ type: 'focus', index: 1, caret: 'end' });
    expect(at({ key: 'Tab', index: 1 })).toEqual({ type: 'exit', where: 'after' });
  });

  it('Shift+Tab 后退，第一个参数跳出到胶囊前', () => {
    expect(at({ key: 'Tab', shift: true, index: 1 })).toEqual({ type: 'focus', index: 0, caret: 'end' });
    expect(at({ key: 'Tab', shift: true })).toEqual({ type: 'exit', where: 'before' });
  });

  it('Enter 提交，Shift+Enter 和输入法组字中不处理', () => {
    expect(at({ key: 'Enter' })).toEqual({ type: 'submit' });
    expect(at({ key: 'Enter', shift: true })).toEqual({ type: 'none' });
    expect(at({ key: 'Enter', composing: true })).toEqual({ type: 'none' });
  });

  it('空参数 Backspace 回退，第一个参数为空时删除胶囊，有内容时交给输入框', () => {
    expect(at({ key: 'Backspace', value: '', index: 1 })).toEqual({ type: 'focus', index: 0, caret: 'end' });
    expect(at({ key: 'Backspace', value: '' })).toEqual({ type: 'remove' });
    expect(at({ key: 'Backspace' })).toEqual({ type: 'none' });
  });

  it('方向键只在边界处跨参数或跳出', () => {
    expect(at({ key: 'ArrowLeft', selectionStart: 0, selectionEnd: 0, index: 1 })).toEqual({ type: 'focus', index: 0, caret: 'end' });
    expect(at({ key: 'ArrowLeft', selectionStart: 0, selectionEnd: 0 })).toEqual({ type: 'exit', where: 'before' });
    expect(at({ key: 'ArrowLeft' })).toEqual({ type: 'none' });
    expect(at({ key: 'ArrowRight', selectionStart: 3, selectionEnd: 3 })).toEqual({ type: 'focus', index: 1, caret: 'start' });
    expect(at({ key: 'ArrowRight', selectionStart: 3, selectionEnd: 3, index: 1 })).toEqual({ type: 'exit', where: 'after' });
  });

  it('Esc 跳出到胶囊后，其他键不处理', () => {
    expect(at({ key: 'Escape' })).toEqual({ type: 'exit', where: 'after' });
    expect(at({ key: 'x' })).toEqual({ type: 'none' });
  });
});
