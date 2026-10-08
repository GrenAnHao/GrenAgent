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

/**
 * 这些事件在胶囊根节点上就停止冒泡，不让外层处理：
 * - Lexical 根节点的 keydown 会触发 KEY_ENTER_COMMAND 等（lobehub 的 onPressEnter 会直接发送）；
 * - beforeinput / input 会被 Lexical 改写或阻止；paste / copy / cut / drop 会被编辑器接管；
 * - React 合成事件挂在应用根容器上，事件到不了，所以输入框用原生监听，不用 React 的 onChange / onKeyDown。
 * keydown / input / paste / mousedown 有专门的处理器（同样停止冒泡），不在这个列表里。
 */
const SWALLOWED_EVENTS = [
  'keyup', 'keypress', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend',
  'cut', 'copy', 'drop', 'dragstart', 'click',
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
  const invalidFrame = useRef<number | undefined>(undefined);

  // 输入框是非受控的（defaultValue 只在挂载时生效）。撤销/重做或程序改了节点值时要手动回写；
  // 正常输入时节点值和 input 值相同，这里是 no-op，不会打断光标。
  useLayoutEffect(() => {
    inputs.current.forEach((input, index) => {
      const value = values[index] ?? '';
      if (input && input.value !== value) input.value = value;
    });
  }, [values]);

  useEffect(
    () => () => {
      window.clearTimeout(invalidTimer.current);
      if (invalidFrame.current !== undefined) window.cancelAnimationFrame(invalidFrame.current);
    },
    [],
  );

  const withNode = useCallback(
    (fn: (node: CommandPillNode) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isCommandPillNode(node)) fn(node);
      });
    },
    [editor, nodeKey],
  );

  /**
   * 离开胶囊（跳出、删除）都走这里。先把焦点交还根节点：Lexical 提交时 updateDOMSelection
   * 见 activeElement 是装饰器里的 input 就直接返回，不设 DOM 选区，光标会留在输入框里。
   * 根节点有焦点后，move 里 selectNext / selectPrevious 产生的新选区会在提交时写进 DOM，不用再 editor.focus()。
   */
  const leavePill = useCallback(
    (move: (node: CommandPillNode) => void) => {
      editor.getRootElement()?.focus({ preventScroll: true });
      withNode(move);
    },
    [editor, withNode],
  );

  const focusArg = useCallback((index: number, caret: 'start' | 'end' = 'end') => {
    const input = inputs.current[index];
    if (!input) return;
    input.focus();
    const at = caret === 'start' ? 0 : input.value.length;
    input.setSelectionRange(at, at);
  }, []);

  /** 参数段描边变红并抖一下。先清掉再在下一帧设上，连续被拦时动画能重播。 */
  const flashInvalid = useCallback((index: number) => {
    window.clearTimeout(invalidTimer.current);
    if (invalidFrame.current !== undefined) window.cancelAnimationFrame(invalidFrame.current);
    setInvalid(null);
    invalidFrame.current = window.requestAnimationFrame(() => {
      invalidFrame.current = undefined;
      setInvalid(index);
      invalidTimer.current = window.setTimeout(() => setInvalid(null), INVALID_FLASH_MS);
    });
  }, []);

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
          if (payload.invalid) flashInvalid(payload.index);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, nodeKey, focusArg, flashInvalid],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const swallow = (event: Event) => event.stopPropagation();
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      const index = argIndexOf(event.target);
      if (index === null) return;
      // Tab 一律由胶囊处理：第一个参数上 Shift+Tab 是 none（不动），不拦的话浏览器会把焦点移出编辑器。
      if (event.key === 'Tab' && !event.isComposing) event.preventDefault();
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
      else if (action.type === 'exit') leavePill((node) => node.selectNext(0, 0));
      else if (action.type === 'remove') {
        leavePill((node) => {
          node.selectPrevious();
          node.remove();
        });
      } else hostRef.current?.submit();
    };
    const onMouseDown = (event: MouseEvent) => {
      event.stopPropagation();
      // 只处理左键：右键要出原生菜单，中键不该把焦点拉进参数框。
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      // 不让光标落到胶囊外的正文里。点参数段的 label 时，原生会把随后的 click 转给里面的 input。
      event.preventDefault();
      if (target instanceof Element && target.closest('label[data-arg-label]')) return;
      const firstEmpty = inputs.current.findIndex((input) => input?.value === '');
      focusArg(firstEmpty === -1 ? 0 : firstEmpty);
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
      if (!text) return;
      event.preventDefault();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.setRangeText(text.replace(/\s*[\r\n]+\s*/g, ' '), start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('mousedown', onMouseDown);
    root.addEventListener('input', onInput);
    root.addEventListener('paste', onPaste);
    SWALLOWED_EVENTS.forEach((type) => root.addEventListener(type, swallow));
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('paste', onPaste);
      SWALLOWED_EVENTS.forEach((type) => root.removeEventListener(type, swallow));
    };
  }, [editor, params.length, focusArg, leavePill, withNode]);

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
        <label
          key={param.name}
          className={cx(pillStyles.arg, focused === index && pillStyles.argFocus, invalid === index && pillStyles.argInvalid)}
          data-arg-label
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
        </label>
      ))}
    </span>
  );
}
