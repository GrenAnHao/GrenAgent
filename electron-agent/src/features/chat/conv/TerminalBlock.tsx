import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, useCallback, useState, type MouseEvent } from 'react';
import {
  terminalCommandLines,
  terminalOutputEmpty,
  terminalPromptLabel,
} from '../../tools/bashCardModel';

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
    align-items: flex-start;
    gap: 8px;
    max-height: 150px;
    padding: 9px 12px;
    overflow: auto;
  `,
  headerSettled: css`
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  runState: css`
    flex: none;
    width: 6px;
    height: 6px;
    margin-block-start: 6px;
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
  promptCol: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
  `,
  promptLine: css`
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
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
    flex: none;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    font-size: 12px;
    line-height: 18px;
  `,
  output: css`
    overflow: auto;
    min-width: 0;
    max-height: 224px;
    padding: 12px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextSecondary};
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
  `,
  empty: css`
    padding: 12px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
}));

export const TerminalBlock = memo(function TerminalBlock({
  command,
  cwd,
  output,
  running = false,
  isError = false,
}: {
  command: string;
  cwd?: string;
  output?: string;
  running?: boolean;
  isError?: boolean;
}) {
  const empty = terminalOutputEmpty(output);
  const commandLines = terminalCommandLines(command);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!output) return;
      try {
        await navigator.clipboard.writeText(output);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // clipboard may be unavailable in tests / restricted contexts
      }
    },
    [output],
  );

  const showBody = running ? !empty : true;

  return (
    <div
      className={styles.block}
      data-testid="terminal-block"
      data-running={running ? '' : undefined}
    >
      <div className={cx(styles.header, showBody && styles.headerSettled)}>
        <span
          className={cx(
            styles.runState,
            running && styles.runStateRunning,
            isError && styles.runStateError,
          )}
          data-testid="terminal-run-state"
        />
        <div className={styles.promptCol}>
          {commandLines.map((line, index) => (
            <div key={index} className={styles.promptLine}>
              <span
                className={styles.prompt}
                data-testid={index === 0 ? 'terminal-prompt' : undefined}
              >
                {index === 0 ? terminalPromptLabel(cwd) : '$'}
              </span>
              <span
                className={styles.command}
                data-testid={index === 0 ? 'terminal-command' : undefined}
              >
                {line}
              </span>
            </div>
          ))}
        </div>
        {!running && !empty ? (
          <button type="button" className={styles.copy} onClick={onCopy}>
            {copied ? '已复制' : '复制'}
          </button>
        ) : null}
      </div>
      {!showBody ? null : empty ? (
        <div className={styles.empty} data-testid="terminal-empty">
          无输出
        </div>
      ) : (
        <div
          className={cx(styles.output, isError && styles.error)}
          data-testid="terminal-output"
          data-variant="terminal"
        >
          {output}
        </div>
      )}
    </div>
  );
});
