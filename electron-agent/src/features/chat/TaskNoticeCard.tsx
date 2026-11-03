import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { AlertTriangle } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { Disclosure } from './conv/Disclosure';
import { StatusGlyph } from './conv/StatusGlyph';
import { convStyles } from './conv/convTokens';
import { LazyMarkdown } from './LazyMarkdown';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0;
    max-width: 100%;
    margin-block: 2px 4px;
    font-size: var(--pi-font-size-secondary, 13px);
  `,
  // 与 ConvRow 同一套紧凑行：26px、hover 淡底、chevron 靠右。
  head: css`
    display: flex;
    align-items: center;
    gap: 7px;
    overflow: hidden;
    box-sizing: border-box;
    width: calc(100% + 14px);
    min-width: 0;
    height: 26px;
    padding: 0 7px;
    margin: 0 -7px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12.5px;
    text-align: start;
    cursor: pointer;
    transition: background 0.12s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  title: css`
    overflow: hidden;
    min-width: 0;
    font-weight: 400;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    flex: none;
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
    font-variant-numeric: tabular-nums;
  `,
  right: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    margin: 2px 0 8px 23px;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
  `,
  sectionLabel: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  // 长正文限高可滚动；展开后关键信息都在，只是不把时间线顶长。
  scroll: css`
    overflow: auto;
    min-width: 0;
    max-width: 100%;
    max-height: min(50vh, 360px);
    padding: 2px 0 2px 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
    scrollbar-width: thin;
    color: ${cssVar.colorText};
    overflow-wrap: anywhere;

    & .pi-md.pi-md.pi-md :is(h1, h2, h3, h4, h5, h6) {
      margin: 4px 0;
      font-size: var(--pi-font-size-secondary, 13px);
      font-weight: 600;
      line-height: inherit;
      color: ${cssVar.colorText};
    }

    & .pi-md.pi-md.pi-md p,
    & .pi-md.pi-md.pi-md p:not(:first-child),
    & .pi-md.pi-md.pi-md p:not(:last-child),
    & .pi-md.pi-md.pi-md li p,
    & .pi-md.pi-md.pi-md li p:not(:first-child),
    & .pi-md.pi-md.pi-md li p:not(:last-child) {
      margin: 4px 0;
    }

    & .pi-md.pi-md.pi-md :is(ul, ol) {
      margin: 2px 0;
      padding-inline-start: 18px;
    }

    & .pi-md.pi-md.pi-md li,
    & .pi-md.pi-md.pi-md li:not(:first-child) {
      margin: 1px 0;
    }
  `,
  output: css`
    overflow: auto;
    min-width: 0;
    max-width: 100%;
    max-height: min(50vh, 320px);
    padding: 6px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorText};
    white-space: pre-wrap;
    word-break: break-word;
    scrollbar-width: thin;
  `,
  diagnostic: css`
    padding-inline-start: 12px;
    border-inline-start: 2px solid ${cssVar.colorErrorBorder};
    color: ${cssVar.colorError};
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  note: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
}));

const WARN_COLOR = cssVar.colorWarning;

/** 取消 / 超时 / 未知不是成功，也不都是错误：用警示图标，但沿用 StatusGlyph 的行首槽位。 */
const WarnGlyph = memo(function WarnGlyph() {
  return (
    <span className={convStyles.lead} data-testid="task-notice-glyph" data-tone="warn" style={{ color: WARN_COLOR }}>
      <Icon icon={AlertTriangle} size={13} />
    </span>
  );
});

export function formatNoticeTime(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleTimeString([], { hour12: false });
}

export interface TaskNoticeCardProps {
  icon: Parameters<typeof Icon>[0]['icon'];
  /** 单行头：状态 + 任务身份 + 短描述；完整命令/正文展开后看。 */
  title: string;
  tone: 'ok' | 'error' | 'warn' | 'neutral';
  /** 状态短语，给无障碍和断言读（标题里也有）。 */
  statusText: string;
  outcome?: string;
  timestamp?: number;
  duration?: string;
  /** 展开后的结果、留存输出与诊断。 */
  children?: ReactNode;
  'data-testid': string;
}

/**
 * 任务终态行：默认收起的一行（状态 + 身份 + 短描述 + 时间），点开才显示完整结果/诊断/数据缺口。
 * 视觉沿用 ConvRow / StatusGlyph / Disclosure 的对话行约定。
 */
export const TaskNoticeCard = memo(function TaskNoticeCard({
  icon,
  title,
  tone,
  statusText,
  outcome,
  timestamp,
  duration,
  children,
  'data-testid': testId,
}: TaskNoticeCardProps) {
  const time = formatNoticeTime(timestamp);
  const expandable = children != null;
  const [open, setOpen] = useState(false);
  const status = tone === 'ok' ? 'done' : tone === 'error' ? 'error' : undefined;
  return (
    <div
      className={styles.root}
      data-testid={testId}
      data-outcome={outcome}
      data-tone={tone}
      data-status={statusText}
      data-state={open ? 'open' : 'closed'}
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={expandable ? open : undefined}
        data-testid={`${testId}-head`}
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
      >
        {status ? <StatusGlyph status={status} /> : <WarnGlyph />}
        <Icon icon={icon} size={14} style={{ color: cssVar.colorTextTertiary, flex: 'none' }} />
        <span className={styles.title} data-testid="task-notice-title">
          {title}
        </span>
        <span className={styles.right}>
          {duration ? (
            <span className={styles.meta} data-testid="task-notice-duration">
              {duration}
            </span>
          ) : null}
          {time && timestamp !== undefined ? (
            <time
              className={styles.meta}
              data-testid="task-notice-time"
              dateTime={new Date(timestamp).toISOString()}
              title={new Date(timestamp).toLocaleString()}
            >
              {time}
            </time>
          ) : null}
          {expandable ? <Disclosure open={open} /> : null}
        </span>
      </button>
      {expandable && open ? (
        <div className={styles.body} data-testid={`${testId}-body`}>
          {children}
        </div>
      ) : null}
    </div>
  );
});

/** 只有正文的分节：结果 / 收尾消息。 */
export const TaskNoticeText = memo(function TaskNoticeText({
  label,
  children,
  testId,
}: {
  label?: string;
  children: string;
  testId: string;
}) {
  return (
    <div className={styles.section}>
      {label ? <span className={styles.sectionLabel}>{label}</span> : null}
      <div className={styles.scroll} data-testid={testId} tabIndex={0} role="region" aria-label={label ?? '任务正文'}>
        <LazyMarkdown variant="chat">{children}</LazyMarkdown>
      </div>
    </div>
  );
});

/** 后台命令的留存输出：等宽、保留换行、限高滚动。 */
export const TaskNoticeOutput = memo(function TaskNoticeOutput({
  label,
  text,
  lossyNote,
  testId,
}: {
  label?: string;
  text: string;
  lossyNote?: string;
  testId: string;
}) {
  return (
    <div className={styles.section}>
      {label ? <span className={styles.sectionLabel}>{label}</span> : null}
      {lossyNote ? (
        <span className={styles.note} data-testid={`${testId}-lossy`}>
          {lossyNote}
        </span>
      ) : null}
      {text.trim() ? (
        <div className={styles.output} data-testid={testId}>
          {text}
        </div>
      ) : null}
    </div>
  );
});

/** 失败 / 超时的诊断：原样保留原因，不美化。 */
export const TaskNoticeDiagnostic = memo(function TaskNoticeDiagnostic({
  label,
  text,
  testId = 'task-notice-diagnostic',
}: {
  label: string;
  text: string;
  testId?: string;
}) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel}>{label}</span>
      <div className={styles.diagnostic} data-testid={testId}>
        {text}
      </div>
    </div>
  );
});

/** 数据缺口 / 投递事实：一句如实说明。 */
export const TaskNoticeNote = memo(function TaskNoticeNote({
  text,
  testId = 'task-notice-note',
}: {
  text: string;
  testId?: string;
}) {
  return (
    <div className={cx(styles.note)} data-testid={testId}>
      {text}
    </div>
  );
});
