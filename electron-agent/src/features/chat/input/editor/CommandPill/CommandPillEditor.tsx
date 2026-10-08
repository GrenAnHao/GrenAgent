import { Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
import { $getNodeByKey, COMMAND_PRIORITY_LOW, type LexicalEditor } from 'lexical';
import { SquareSlash } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PromptParam } from '@extensions/prompt-commands/syntax';
import { $isCommandPillNode, type CommandPillNode } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND, takePillFocus } from './commands';
import { CommandPillHostContext } from './hostContext';
import { pillStyles } from './commandPillStyles';
import { pillKeyAction } from './pillKeys';

const INVALID_FLASH_MS = 900;

/** 在胶囊上就截住，不让 Lexical 根节点和 React 根节点处理（见计划任务 10 的约束）。 */
const SWALLOWED_EVENTS = [
  'keyup', 'keypress', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend',
  'cut', 'copy', 'drop', 'dragstart', 'mousedown', 'click',
] as const;

interface CommandPillEditorProps {
  editor: LexicalEditor;
  nodeKey: string;
  name: string;
  params: PromptParam[];
  values: string[];
}

function argIndexOf(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLInputElement)) return null;
  const index = Number(target.dataset.argIndex);
  return Number.isInteger(index) ? index : null;
}

/** 输入框里的可编辑命令胶囊。参数是非受控原生 input，值通过原生 input 事件写回节点。 */
export function CommandPillEditor({ editor, nodeKey, name, params, values }: CommandPillEditorProps) {
  const host = useContext(CommandPillHostContext);
  const hostRef = useRef(host);
  hostRef.current = host;
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const [invalid, setInvalid] = useState<number | null>(null);
  const invalidTimer = useRef<number | undefined>(undefined);

  // 输入框是非受控的（defaultValue 只在挂载时生效）。撤销/重做或程序改了节点值时要手动回写；
  // 正常输入时节点值和 input 值相同，这里是 no-op，不会打断光标。
  useLayoutEffect(() => {
    inputs.current.forEach((input, index) => {
      const value = values[index] ?? '';
      if (input && input.value !== value) input.value = value;
    });
  }, [values]);

  useEffect(() => () => window.clearTimeout(invalidTimer.current), []);

  const withNode = useCallback(
    (fn: (node: CommandPillNode) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isCommandPillNode(node)) fn(node);
      });
    },
    [editor, nodeKey],
  );

  const focusArg = useCallback((index: number, caret: 'start' | 'end' = 'end') => {
    const input = inputs.current[index];
    if (!input) return;
    input.focus();
    const at = caret === 'start' ? 0 : input.value.length;
    input.setSelectionRange(at, at);
  }, []);

  const exit = useCallback(
    (where: 'before' | 'after') => {
      withNode((node) => {
        if (where === 'after') node.selectNext(0, 0);
        else node.selectPrevious();
      });
      editor.focus();
    },
    [editor, withNode],
  );

  useLayoutEffect(() => {
    const index = takePillFocus(nodeKey);
    if (index !== undefined) focusArg(index);
  }, [nodeKey, focusArg]);

  useEffect(
    () =>
      editor.registerCommand(
        FOCUS_PILL_ARG_COMMAND,
        (payload) => {
          if (payload.key !== nodeKey) return false;
          focusArg(payload.index);
          if (payload.invalid) {
            setInvalid(payload.index);
            window.clearTimeout(invalidTimer.current);
            invalidTimer.current = window.setTimeout(() => setInvalid(null), INVALID_FLASH_MS);
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, nodeKey, focusArg],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const swallow = (event: Event) => event.stopPropagation();
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      const index = argIndexOf(event.target);
      if (index === null) return;
      const input = event.target as HTMLInputElement;
      const action = pillKeyAction({
        key: event.key,
        shift: event.shiftKey,
        composing: event.isComposing,
        value: input.value,
        selectionStart: input.selectionStart ?? 0,
        selectionEnd: input.selectionEnd ?? 0,
        index,
        count: params.length,
      });
      if (action.type === 'none') return;
      event.preventDefault();
      if (action.type === 'focus') focusArg(action.index, action.caret);
      else if (action.type === 'exit') exit(action.where);
      else if (action.type === 'remove') {
        withNode((node) => {
          node.selectPrevious();
          node.remove();
        });
        editor.focus();
      } else hostRef.current?.submit();
    };
    const onInput = (event: Event) => {
      event.stopPropagation();
      const index = argIndexOf(event.target);
      if (index === null) return;
      const value = (event.target as HTMLInputElement).value;
      withNode((node) => node.setValue(index, value));
    };
    const onPaste = (event: ClipboardEvent) => {
      event.stopPropagation();
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.setRangeText(text.replace(/\s*\r?\n\s*/g, ' '), start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('input', onInput);
    root.addEventListener('paste', onPaste);
    SWALLOWED_EVENTS.forEach((type) => root.addEventListener(type, swallow));
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('paste', onPaste);
      SWALLOWED_EVENTS.forEach((type) => root.removeEventListener(type, swallow));
    };
  }, [editor, params.length, focusArg, exit, withNode]);

  return (
    <span
      ref={rootRef}
      className={pillStyles.pill}
      data-command-pill
      data-testid="command-pill"
      data-command={name}
      data-noarg={params.length === 0}
      contentEditable={false}
    >
      <span className={pillStyles.command}>
        <Icon icon={SquareSlash} size={13} />
        {name}
      </span>
      {params.map((param, index) => (
        <span
          key={param.name}
          className={cx(pillStyles.arg, focused === index && pillStyles.argFocus, invalid === index && pillStyles.argInvalid)}
          data-testid="command-pill-arg"
          data-invalid={invalid === index}
        >
          <span className={pillStyles.key}>{param.name}</span>
          <input
            ref={(el) => {
              inputs.current[index] = el;
            }}
            className={pillStyles.input}
            data-arg-index={index}
            data-arg-name={param.name}
            defaultValue={values[index] ?? ''}
            placeholder={param.defaultValue ?? param.name}
            spellCheck={false}
            onFocus={() => setFocused(index)}
            onBlur={() => setFocused((current) => (current === index ? null : current))}
          />
        </span>
      ))}
    </span>
  );
}
