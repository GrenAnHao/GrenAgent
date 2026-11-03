import { createContext, useContext, useState, type ReactNode } from 'react';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowRight, Mail } from 'lucide-react';
import { LazyMarkdown } from './LazyMarkdown';
import { StatusGlyph, type ConvStatus } from './conv/StatusGlyph';
import { Disclosure } from './conv/Disclosure';

/** A child transcript is rendered inside its parent's store provider; never use that store as the sender. */
export const AgentIdentityContext = createContext<string | undefined>(undefined);
export const useAgentIdentity = () => useContext(AgentIdentityContext) || '当前会话代理';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0;
    max-width: 100%;
    margin-block: 4px 8px;
    font-size: var(--pi-font-size-secondary, 13px);
  `,
  head: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 7px;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    text-align: start;
    cursor: pointer;
    color: ${cssVar.colorTextSecondary};
    font-family: inherit;
    font-size: 12px;
    line-height: 22px;
    overflow-wrap: anywhere;

    &:hover { background: ${cssVar.colorFillTertiary}; }
  `,
  participant: css`
    min-width: 0;
    font-weight: 500;
    color: ${cssVar.colorText};
    overflow-wrap: anywhere;
  `,
  meta: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  `,
  body: css`
    min-width: 0;
    max-width: 100%;
    max-height: 320px;
    overflow: auto;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
    margin: 4px 0 0 23px;
    padding: 4px 0 4px 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorText};
  `,
  note: css`
    margin: 4px 0 0 35px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
}));

export function AgentCommunicationCard({ sender, recipient, body, state, status, timestamp, meta, note, testId }: {
  sender: string;
  recipient: string;
  body: string;
  state: string;
  status?: ConvStatus;
  timestamp?: number;
  meta?: ReactNode;
  note?: string;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const date = typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp) : null;
  const validDate = date && Number.isFinite(date.getTime()) ? date : null;
  return (
    <div className={styles.root} data-testid={testId}>
      <button type="button" className={styles.head} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} data-testid="agent-message-toggle">
        {status ? <StatusGlyph status={status} /> : null}
        <Icon icon={Mail} size={14} style={{ color: cssVar.colorTextTertiary, flex: 'none' }} />
        <span>代理消息</span>
        <span className={styles.participant}>{sender}</span>
        <Icon icon={ArrowRight} size={12} />
        <span className={styles.participant}>{recipient}</span>
        <span className={styles.meta} data-testid="agent-message-state">{state}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
        {validDate ? <time className={styles.meta} dateTime={validDate.toISOString()} title={validDate.toLocaleString()}>{validDate.toLocaleTimeString([], { hour12: false })}</time> : null}
        <span style={{ marginInlineStart: 'auto', display: 'inline-flex' }}><Disclosure open={expanded} /></span>
      </button>
      {expanded && (body.trim() ? (
        <div className={styles.body} data-testid="agent-message-body" tabIndex={0} role="region" aria-label="代理消息正文">
          <LazyMarkdown variant="chat">{body}</LazyMarkdown>
        </div>
      ) : <div className={styles.note}>这条记录未包含消息正文。</div>)}
      {expanded && note ? <div className={styles.note} data-testid="agent-message-note">{note}</div> : null}
    </div>
  );
}
