import { ActionIcon, Flexbox, Segmented } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { LazyHighlighter } from '../tools/LazyHighlighter';
import type { PageView } from '../../stores/rightPanelStore';

const styles = createStaticStyles(({ css }) => ({
  url: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  meta: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  body: css`
    overflow-x: hidden;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding-inline-end: 4px;
    font-size: 13px;
    line-height: 1.6;
    color: ${cssVar.colorText};

    /* 长文/长 URL 换行，别顶到右边框 */
    word-break: break-word;
    overflow-wrap: anywhere;
  `,
}));

type Tab = 'preview' | 'raw';

/** 右侧整页内容查看（对齐 lobe web-browsing）：URL + 字符数/抓取模式 + 预览/原始文本。 */
export function PageContentViewer({ page, onClose }: { page: PageView; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('preview');
  const trimmed = page.content.trim();
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  return (
    <Flexbox flex={1} gap={8} style={{ minHeight: 0, padding: 10 }} data-testid="page-viewer">
      <Flexbox horizontal align="center" gap={6}>
        <ActionIcon icon={ChevronLeft} size="small" title="返回" onClick={onClose} />
        <a className={styles.url} href={page.url} target="_blank" rel="noreferrer">
          {page.url}
        </a>
        <ActionIcon
          icon={ExternalLink}
          size="small"
          title="打开链接"
          onClick={() => void openPath(page.url)}
        />
      </Flexbox>

      {page.chars != null || page.crawler ? (
        <Flexbox horizontal gap={12} className={styles.meta}>
          {page.chars != null ? <span>字符数：{page.chars}</span> : null}
          {page.crawler ? <span>抓取模式：{page.crawler}</span> : null}
        </Flexbox>
      ) : null}

      <Segmented
        value={tab}
        onChange={(v) => setTab(String(v) as Tab)}
        options={[
          { label: '预览', value: 'preview' },
          { label: '原始文本', value: 'raw' },
        ]}
      />

      <div className={styles.body}>
        {isJson ? (
          // JSON 内容两个 Tab 都按 JSON 高亮（对齐 lobe 的整洁高亮）。
          <LazyHighlighter language="json" copyable variant="borderless">
            {page.content}
          </LazyHighlighter>
        ) : tab === 'preview' ? (
          <LazyMarkdown variant="chat" fontSize={13}>
            {page.content}
          </LazyMarkdown>
        ) : (
          <LazyHighlighter language="markdown" copyable variant="borderless">
            {page.content}
          </LazyHighlighter>
        )}
      </div>
    </Flexbox>
  );
}
