export interface PillKeyInput {
  key: string;
  shift: boolean;
  composing: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  index: number;
  count: number;
}

export type PillKeyAction =
  | { type: 'none' }
  | { type: 'focus'; index: number; caret: 'start' | 'end' }
  | { type: 'exit'; where: 'before' | 'after' }
  | { type: 'remove' }
  | { type: 'submit' };

const NONE: PillKeyAction = { type: 'none' };

function previous(input: PillKeyInput): PillKeyAction {
  return input.index > 0 ? { type: 'focus', index: input.index - 1, caret: 'end' } : { type: 'exit', where: 'before' };
}

function next(input: PillKeyInput, caret: 'start' | 'end'): PillKeyAction {
  return input.index < input.count - 1 ? { type: 'focus', index: input.index + 1, caret } : { type: 'exit', where: 'after' };
}

/** 胶囊参数输入框里的按键 → 动作。纯函数，规格「输入框」一节的按键表。 */
export function pillKeyAction(input: PillKeyInput): PillKeyAction {
  if (input.composing) return NONE;
  const collapsed = input.selectionStart === input.selectionEnd;
  switch (input.key) {
    case 'Tab':
      return input.shift ? previous(input) : next(input, 'end');
    case 'Enter':
      return input.shift ? NONE : { type: 'submit' };
    case 'Backspace':
      if (input.value !== '') return NONE;
      return input.index > 0 ? previous(input) : { type: 'remove' };
    case 'ArrowLeft':
      return collapsed && input.selectionStart === 0 ? previous(input) : NONE;
    case 'ArrowRight':
      return collapsed && input.selectionEnd === input.value.length ? next(input, 'start') : NONE;
    case 'Escape':
      return { type: 'exit', where: 'after' };
    default:
      return NONE;
  }
}
