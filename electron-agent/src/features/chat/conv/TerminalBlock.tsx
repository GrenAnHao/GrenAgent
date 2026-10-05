import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Dropdown, type MenuProps } from 'antd';
import { ChevronDown } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  terminalCommandHead,
  terminalCopyText,
  terminalOutputEmpty,
  terminalPromptLabel,
  type TerminalCopyKind,
} from '../../tools/bashCardModel';

/** 输出区上限，超出后在区内滚动。 */
const OUTPUT_MAX_HEIGHT = 224;

const styles = createStaticStyles(({ css }) => ({
  block: css`
    overflow: hidden;
    min-width: 0;
    max-width: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 7px 8px 7px 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  runState: css`
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorSuccess};
  `,
  runStateRunning: css`
    background: ${cssVar.colorInfo};
    animation: terminalDotPulse 1.4s ease-in-out infinite;

    @keyframes terminalDotPulse {
      0%,
      100% {
        opacity: 0.3;
      }
      50% {
        opacity: 1;
      }
    }
  `,
  runStateError: css`
    background: ${cssVar.colorError};
  `,
  promptLine: css`
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
  `,
  prompt: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
    user-select: none;
  `,
  command: css`
    overflow: hidden;
    min-width: 0;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: pre;
  `,
  copy: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    font-size: 12px;
    line-height: 18px;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  output: css`
    overflow: auto;
    min-width: 0;
    max-height: ${OUTPUT_MAX_HEIGHT}px;
    padding: 12px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextSecondary};
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
  `,
  placeholder: css`
    padding: 12px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextTertiary};
  `,
  waiting: css`
    animation: terminalWaitingPulse 1.6s ease-in-out infinite;

    @keyframes terminalWaitingPulse {
      0%,
      100% {
        opacity: 0.45;
      }
      50% {
        opacity: 1;
      }
    }
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  footer: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 5px 8px 5px 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const COPY_LABEL: Record<TerminalCopyKind, string> = {
  command: '复制命令',
  output: '复制结果',
  all: '复制全部',
};

/**
 * 命令行卡片。一出现就是完整形态：单行命令头 + 输出区。还没收到输出时输出区先放一行「等待响应中」，
 * 它和一行输出等高，第一行输出到来时卡片不跳；之后随输出长高到上限再滚动，结束时不收缩。
 */
export const TerminalBlock = memo(function TerminalBlock({
  command,
  cwd,
  output,
  running = false,
  isError = false,
  footer,
}: {
  command: string;
  cwd?: string;
  output?: string;
  running?: boolean;
  isError?: boolean;
  /** 输出区下的一行（后台 job 的状态与停止）。 */
  footer?: ReactNode;
}) {
  const empty = terminalOutputEmpty(output);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running) return;
    const node = outputRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [output, running]);

  const copy = useCallback(
    async (kind: TerminalCopyKind) => {
      try {
        await navigator.clipboard.writeText(terminalCopyText(kind, command, output));
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // clipboard may be unavailable in tests / restricted contexts
      }
    },
    [command, output],
  );

  const menu = useMemo<MenuProps>(
    () => ({
      items: (['command', 'output', 'all'] as const).map((kind) => ({
        key: kind,
        label: COPY_LABEL[kind],
        disabled: kind === 'output' && empty,
      })),
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        void copy(key as TerminalCopyKind);
      },
    }),
    [copy, empty],
  );

  const stop = (event: MouseEvent) => event.stopPropagation();

  let body;
  if (!empty) {
    body = (
      <div
        ref={outputRef}
        className={cx(styles.output, isError && styles.error)}
        data-testid="terminal-output"
        data-variant="terminal"
      >
        {output}
      </div>
    );
  } else if (running) {
    body = (
      <div className={cx(styles.placeholder, styles.waiting)} data-testid="terminal-waiting">
        等待响应中
      </div>
    );
  } else {
    body = (
      <div className={styles.placeholder} data-testid="terminal-empty">
        无输出
      </div>
    );
  }

  return (
    <div
      className={styles.block}
      data-testid="terminal-block"
      data-running={running ? '' : undefined}
    >
      <div className={styles.header}>
        <span
          className={cx(
            styles.runState,
            running && styles.runStateRunning,
            isError && styles.runStateError,
          )}
          data-testid="terminal-run-state"
        />
        <div className={styles.promptLine}>
          <span className={styles.prompt} data-testid="terminal-prompt">
            {terminalPromptLabel(cwd)}
          </span>
          <span className={styles.command} data-testid="terminal-command" title={command}>
            {terminalCommandHead(command)}
          </span>
        </div>
        <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
          <button
            type="button"
            className={styles.copy}
            aria-label="复制"
            aria-haspopup="menu"
            onClick={stop}
          >
            {copied ? '已复制' : '复制'}
            <ChevronDown size={12} aria-hidden />
          </button>
        </Dropdown>
      </div>
      {body}
      {footer ? (
        <div className={styles.footer} data-testid="terminal-footer">
          {footer}
        </div>
      ) : null}
    </div>
  );
});
