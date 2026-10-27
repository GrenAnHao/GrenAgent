import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { closeFind, FIND_BAR_HEIGHT } from './findActions';
import { useFindScope, useFindStore } from './findStore';

const styles = createStaticStyles(({ css }) => ({
  /* 通栏条：整行占位，控件靠右。高度和底边线由调用方的布局决定它「占一行」，不盖内容。 */
  bar: css`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    box-sizing: border-box;
    height: ${FIND_BAR_HEIGHT}px;
    padding: 0 12px;
    background: ${cssVar.colorBgContainer};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  input: css`
    display: flex;
    flex: 0 1 240px;
    align-items: center;
    gap: 6px;
    min-width: 96px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorText};
    font-size: 13px;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      box-shadow 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-within {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorBgContainer};
      box-shadow: 0 0 0 2px ${cssVar.colorPrimaryBg};
    }

    &[data-empty-result='true'] {
      border-color: ${cssVar.colorError};
    }

    &[data-empty-result='true']:focus-within {
      box-shadow: 0 0 0 2px ${cssVar.colorErrorBg};
    }

    svg {
      flex: none;
      color: ${cssVar.colorTextTertiary};
    }

    input {
      flex: 1;
      min-width: 0;
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: inherit;
      font: inherit;
    }

    input::placeholder {
      color: ${cssVar.colorTextTertiary};
    }
  `,
  count: css`
    flex: none;
    min-width: 54px;
    padding: 0 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: center;
    white-space: nowrap;

    &[data-empty-result='true'] {
      color: ${cssVar.colorError};
    }
  `,
  sep: css`
    flex: none;
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: ${cssVar.colorBorderSecondary};
  `,
  button: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: -2px;
    }

    &:disabled {
      opacity: 0.35;
      cursor: default;
    }
  `,
}));

export interface FindBarProps {
  scope: string;
  placeholder: string;
  'data-testid'?: string;
}

/**
 * 查找栏：输入框、命中计数（当前 / 总数）、上一个、下一个、关闭。会话和文件共用。
 * 它不做查找本身：查询和上下一个的请求写进 findStore，各范围自己的驱动读去执行、把结果写回 status。
 */
export function FindBar({ scope, placeholder, 'data-testid': testId = 'find-bar' }: FindBarProps) {
  const { query, status, focusNonce } = useFindScope(scope);
  const setQuery = useFindStore((state) => state.setQuery);
  const navigate = useFindStore((state) => state.navigate);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次「打开 / 再按 Ctrl+F」焦点进输入框并全选，直接打字就是换查询。
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce]);

  const hasQuery = query.trim() !== '';
  const noResult = hasQuery && status.total === 0;
  const canJump = status.total > 0;
  const countText = !hasQuery ? '' : noResult ? '无结果' : `${status.current} / ${status.total}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (canJump) navigate(scope, event.shiftKey ? 'prev' : 'next');
    } else if (event.key === 'Escape') {
      // 不再往上冒：别处的 Esc（停止生成、退出编辑）不该跟着触发。
      event.preventDefault();
      event.stopPropagation();
      closeFind(scope);
    }
  };

  return (
    <div className={styles.bar} role="search" aria-label={placeholder} data-testid={testId} data-find-ignore="">
      <div className={styles.input} data-empty-result={noResult ? 'true' : undefined}>
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="find-input"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(scope, event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span className={styles.count} data-testid="find-count" data-empty-result={noResult ? 'true' : undefined} aria-live="polite">
        {countText}
      </span>
      <span className={styles.sep} aria-hidden="true" />
      <button
        type="button"
        className={styles.button}
        data-testid="find-prev"
        title="上一个（Shift+Enter）"
        aria-label="上一个"
        disabled={!canJump}
        onClick={() => navigate(scope, 'prev')}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={styles.button}
        data-testid="find-next"
        title="下一个（Enter）"
        aria-label="下一个"
        disabled={!canJump}
        onClick={() => navigate(scope, 'next')}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={styles.button}
        data-testid="find-close"
        title="关闭（Esc）"
        aria-label="关闭查找"
        onClick={() => closeFind(scope)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
