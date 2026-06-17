import { Accordion, AccordionItem, Block, Flexbox, Icon, ScrollArea } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { ChevronRight, Search } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LazyHighlighter } from './LazyHighlighter';
import { useCardStyles } from './cardStyles';
import { StatusIndicator } from './StatusIndicator';
import { renderExtensionCard } from './extensionCards';
import {
  argSummary,
  extractText,
  getArgString,
  getDetails,
  getDiff,
  langByPath,
  stringifyJson,
  toolMeta,
} from './toolUtils';

interface ToolExecutionProps {
  toolName: string;
  /** Optional: present when rendered from grouped messages; not needed for display. */
  toolCallId?: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function ToolInspector({
  toolName,
  args,
  result,
  status,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  status: ToolExecutionProps['status'];
}) {
  const { styles } = useCardStyles();

  // web_search / search：读作「搜索：<高亮查询词>（N）」。
  if (toolName.toLowerCase() === 'web_search' || toolName.toLowerCase() === 'search') {
    const query = getArgString(args, 'query');
    const details = getDetails(result);
    const countRaw = details?.count;
    const count =
      typeof countRaw === 'number'
        ? countRaw
        : Array.isArray(details?.results)
          ? (details!.results as unknown[]).length
          : undefined;
    return (
      <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0, flex: 1 }}>
        {status === 'running' ? (
          <StatusIndicator status="running" />
        ) : (
          <Block
            horizontal
            align="center"
            justify="center"
            variant="outlined"
            style={{
              flex: 'none',
              width: 24,
              height: 24,
              fontSize: 12,
              color: status === 'error' ? cssVar.colorError : cssVar.colorTextSecondary,
            }}
          >
            <Icon icon={Search} size={14} />
          </Block>
        )}
        <div className={styles.inspectorTitle}>
          搜索：
          {query ? (
            <span className={styles.queryHighlight}>{query}</span>
          ) : (
            <span className={styles.toolName}>{toolName.toLowerCase()}</span>
          )}
          {count != null ? <span className={styles.searchCount}>（{count}）</span> : null}
        </div>
      </Flexbox>
    );
  }

  // fetch_url：读作「读取页面内容：<url>」，对齐 lobe web-browsing。
  if (toolName.toLowerCase() === 'fetch_url') {
    const url = getArgString(args, 'url');
    return (
      <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0, flex: 1 }}>
        <StatusIndicator status={status} />
        <div className={styles.inspectorTitle}>
          读取页面内容：<span className={styles.paramValue}>{url}</span>
        </div>
      </Flexbox>
    );
  }

  const { icon } = toolMeta(toolName);
  const summary = argSummary(args);

  return (
    <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0, flex: 1 }}>
      <StatusIndicator status={status} />
      <Icon icon={icon} size={14} />
      <div className={styles.inspectorTitle}>
        <span className={styles.toolName}>{toolName}</span>
        {summary && (
          <>
            <Icon icon={ChevronRight} size={12} style={{ marginInline: 4, verticalAlign: 'middle' }} />
            <span className={styles.paramKey}>(</span>
            <span className={styles.paramValue}>{summary}</span>
            <span className={styles.paramKey}>)</span>
          </>
        )}
      </div>
    </Flexbox>
  );
}

function TerminalOutput({ text, isError }: { text: string; isError?: boolean }) {
  const { styles, cx } = useCardStyles();
  if (!text) return null;
  return (
    <div className={cx(styles.terminalOutput, isError && styles.terminalOutputError)}>{text}</div>
  );
}

function ToolDetail({
  toolName,
  args,
  result,
  status,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  status: ToolExecutionProps['status'];
}) {
  const { styles } = useCardStyles();
  const extensionCard = renderExtensionCard({ toolName, args, result, status });
  if (extensionCard) {
    // 统一给扩展卡片留出与上方 inspector 标题行的间距（对齐 lobe，避免贴在一起）。
    return (
      <ErrorBoundary>
        <div style={{ marginBlockStart: 10 }}>{extensionCard}</div>
      </ErrorBoundary>
    );
  }
  const name = toolName.toLowerCase();
  const text = extractText(result);
  const diff = getDiff(result);
  const isError = status === 'error';

  if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
    const command = getArgString(args, 'command');
    return (
      <Flexbox gap={8}>
        {command && (
          <LazyHighlighter language="bash" copyable variant="borderless" style={{ maxHeight: 200 }}>
            {command}
          </LazyHighlighter>
        )}
        <TerminalOutput text={text} isError={isError} />
      </Flexbox>
    );
  }

  if (name === 'read' || name === 'read_file') {
    const path = getArgString(args, 'path');
    const lang = langByPath(path);
    return (
      <Flexbox gap={8}>
        {path && (
          <div className={styles.pathLabel}>
            {path}
          </div>
        )}
        {text ? (
          <LazyHighlighter language={lang} copyable style={{ maxHeight: 320 }}>
            {text}
          </LazyHighlighter>
        ) : (
          <TerminalOutput text={stringifyJson(result)} isError={isError} />
        )}
      </Flexbox>
    );
  }

  if (name === 'write' || name === 'write_file') {
    const path = getArgString(args, 'path');
    const content = getArgString(args, 'content') || text;
    const lang = langByPath(path);
    return (
      <Flexbox gap={8}>
        {path && (
          <div className={styles.pathLabel}>
            {path}
          </div>
        )}
        {content && (
          <LazyHighlighter language={lang} copyable style={{ maxHeight: 320 }}>
            {content}
          </LazyHighlighter>
        )}
      </Flexbox>
    );
  }

  if (name === 'edit' || name === 'search_replace' || name === 'str_replace') {
    const path = getArgString(args, 'path');
    if (diff) {
      return (
        <Flexbox gap={8}>
          {path && (
            <div className={styles.pathLabel}>
              {path}
            </div>
          )}
          <LazyHighlighter language="diff" copyable style={{ maxHeight: 320 }}>
            {diff}
          </LazyHighlighter>
        </Flexbox>
      );
    }
    const oldText = getArgString(args, 'oldText') || getArgString(args, 'old_string');
    const newText = getArgString(args, 'newText') || getArgString(args, 'new_string');
    return (
      <Flexbox gap={8}>
        {path && (
          <div className={styles.pathLabel}>
            {path}
          </div>
        )}
        {oldText && (
          <LazyHighlighter language="diff" copyable style={{ maxHeight: 160 }}>
            {`- ${oldText}`}
          </LazyHighlighter>
        )}
        {newText && (
          <LazyHighlighter language="diff" copyable style={{ maxHeight: 160 }}>
            {`+ ${newText}`}
          </LazyHighlighter>
        )}
        {!oldText && !newText && <TerminalOutput text={text || stringifyJson(result)} isError={isError} />}
      </Flexbox>
    );
  }

  if (name === 'glob' || name === 'grep' || name === 'ripgrep' || name === 'ls' || name === 'list_dir') {
    return <TerminalOutput text={text || stringifyJson(result)} isError={isError} />;
  }

  if (text) {
    return <TerminalOutput text={text} isError={isError} />;
  }

  const json = stringifyJson(result);
  if (!json) return null;
  return (
    <LazyHighlighter language="json" copyable style={{ maxHeight: 300 }}>
      {json}
    </LazyHighlighter>
  );
}

function ToolExecutionInner({ toolName, args, result, status }: ToolExecutionProps) {
  const { styles } = useCardStyles();
  const [expanded, setExpanded] = useState(status === 'running');
  const hasDetail = useMemo(() => {
    if (status === 'running') return true;
    return Boolean(extractText(result) || getDiff(result) || stringifyJson(result));
  }, [result, status]);

  const inspector = (
    <ToolInspector toolName={toolName} args={args} result={result} status={status} />
  );

  if (!hasDetail && status !== 'running') {
    // 无可展开详情：仅一行 Inspector（不显示展开箭头）。
    return (
      <div className={styles.toolRow}>
        <Accordion disableAnimation gap={4} variant="borderless" expandedKeys={[]}>
          <AccordionItem
            allowExpand={false}
            hideIndicator
            itemKey="tool"
            paddingBlock={4}
            paddingInline={4}
            title={inspector}
          />
        </Accordion>
      </div>
    );
  }

  return (
    <div className={styles.toolRow}>
      <Accordion
        disableAnimation
        gap={4}
        variant="borderless"
        expandedKeys={expanded ? ['tool'] : []}
        onExpandedChange={(keys) => setExpanded(keys.includes('tool'))}
      >
        <AccordionItem itemKey="tool" paddingBlock={4} paddingInline={4} title={inspector}>
          <ScrollArea disableContentFit scrollFade viewportProps={{ className: styles.detailScroll }}>
            <Flexbox gap={8} paddingBlock={8}>
              <ToolDetail toolName={toolName} args={args} result={result} status={status} />
              <div className={styles.divDash} />
            </Flexbox>
          </ScrollArea>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

// memo：工具卡片只在自身 args/result/status 变化时重渲染。store 对未变消息保持引用稳定，
// 故流式中其他消息更新时，本卡片不会被动重渲染（避免每帧重解析 result）。
export const ToolExecution = memo(ToolExecutionInner);
