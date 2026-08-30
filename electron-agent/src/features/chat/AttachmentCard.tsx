import { memo, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { ChevronRight, ClipboardList } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import FileIcon from '../../components/FileIcon';
import type { AttachmentBlock } from './attachment';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    width: 100%;
    min-width: 260px;
    max-width: 480px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillTertiary};
  `,
  head: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  ico: css`
    display: flex;
    flex-shrink: 0;
    color: ${cssVar.colorTextSecondary};
  `,
  title: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    flex-shrink: 0;
    margin-left: auto;
    padding-left: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;
  `,
  chev: css`
    display: flex;
    flex-shrink: 0;
    color: ${cssVar.colorTextTertiary};
    transition: transform 0.15s ease;
  `,
  chevOpen: css`
    transform: rotate(90deg);
  `,
  body: css`
    overflow: auto;

    max-height: 240px;
    margin: 0;
    padding: 8px 10px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};

    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.55;
    color: ${cssVar.colorText};
    white-space: pre;

    background: ${cssVar.colorBgContainer};
  `,
}));

function baseName(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function titleOf(block: AttachmentBlock): string {
  return block.attType === 'file' && block.path ? baseName(block.path) : '粘贴文本';
}

function metaOf(block: AttachmentBlock): string {
  if (block.attType === 'text' && block.chars != null) {
    return `${block.lines} 行 · ${formatChars(block.chars)} 字`;
  }
  return `${block.lines} 行`;
}

function AttachmentCardInner({ block }: { block: AttachmentBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.card}>
      <div className={styles.head} onClick={() => setOpen((v) => !v)} title={block.path}>
        <span className={styles.ico}>
          {block.attType === 'file' && block.path ? (
            <FileIcon fileName={baseName(block.path)} size={15} variant="raw" />
          ) : (
            <Icon icon={ClipboardList} size={15} />
          )}
        </span>
        <span className={styles.title}>{titleOf(block)}</span>
        <span className={styles.meta}>{metaOf(block)}</span>
        <span className={cx(styles.chev, open && styles.chevOpen)}>
          <Icon icon={ChevronRight} size={14} />
        </span>
      </div>
      {open ? <pre className={styles.body}>{block.content}</pre> : null}
    </div>
  );
}

export const AttachmentCard = memo(AttachmentCardInner);
