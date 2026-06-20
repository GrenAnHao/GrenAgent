import { Accordion, AccordionItem, Block, Flexbox, Icon, ScrollArea } from '@lobehub/ui';
import { cssVar, cx } from 'antd-style';
import { Check, ChevronRight, Copy, Search, Sparkles } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LazyHighlighter } from './LazyHighlighter';
import { cardStyles } from './cardStyles';
import { StatusIndicator } from './StatusIndicator';
import { renderExtensionCard } from './extensionCards';
import { AnsweredQuestionsCard } from './AnsweredQuestionsCard';
import { InlineQuestionCard } from '../chat/InlineQuestionCard';
import { CodeSearchCard, GlobCard, GrepCard } from './SearchCards';
import {
  argSummary,
  extractText,
  getArgString,
  getDetails,
  getDiff,
  langByPath,
  skillNameFromRead,
  stringifyJson,
  toolMeta,
} from './toolUtils';
import { parseCodeSearchHits, parseGlobOutput, parseGrepOutput } from '../../lib/searchResults';

interface ToolExecutionProps {
  toolName: string;
  /** Optional: present when rendered from grouped messages; not needed for display. */
  toolCallId?: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

/** Cursor 风格的搜索标题：状态点 + 放大镜 + 「<label> <查询词> · N <unit>」。 */
function SearchInspectorTitle({
  status,
  label,
  query,
  count,
  unit,
  fallback,
}: {
  status: ToolExecutionProps['status'];
  label: string;
  query: string;
  count?: number;
  unit: string;
  fallback: string;
}) {
  const styles = cardStyles;
  return (
    <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0, flex: 1 }}>
      <StatusIndicator status={status} />
      <Icon icon={Search} size={14} />
      <div className={styles.inspectorTitle}>
        {label}{' '}
        {query ? (
          <span className={styles.queryHighlight}>{query}</span>
        ) : (
          <span className={styles.toolName}>{fallback}</span>
        )}
        {count != null ? (
          <span className={styles.searchCount}>
            {' · '}
            {count} {unit}
          </span>
        ) : null}
      </div>
    </Flexbox>
  );
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
  const styles = cardStyles;

  // 模型用 read 读 SKILL.md = 调用技能：读作「使用技能 <技能名>」，配技能图标(Sparkles)。
  const skillName = skillNameFromRead(toolName, args);
  if (skillName) {
    return (
      <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0, flex: 1 }}>
        <StatusIndicator status={status} />
        <Icon icon={Sparkles} size={14} />
        <div className={styles.inspectorTitle}>
          使用技能 <span className={styles.skillName}>{skillName}</span>
        </div>
      </Flexbox>
    );
  }

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

  const lname = toolName.toLowerCase();
  if (lname === 'grep' || lname === 'ripgrep') {
    return (
      <SearchInspectorTitle
        status={status}
        label="检索"
        query={getArgString(args, 'pattern')}
        count={status === 'running' ? undefined : parseGrepOutput(extractText(result)).total}
        unit="处"
        fallback={lname}
      />
    );
  }
  if (lname === 'glob') {
    return (
      <SearchInspectorTitle
        status={status}
        label="查找文件"
        query={getArgString(args, 'pattern')}
        count={status === 'running' ? undefined : parseGlobOutput(extractText(result)).files.length}
        unit="个"
        fallback={lname}
      />
    );
  }
  if (lname === 'code_search') {
    return (
      <SearchInspectorTitle
        status={status}
        label="代码检索"
        query={getArgString(args, 'query')}
        count={status === 'running' ? undefined : parseCodeSearchHits(result).length}
        unit="处"
        fallback={lname}
      />
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
  const styles = cardStyles;
  if (!text) return null;
  return (
    <div className={cx(styles.terminalOutput, isError && styles.terminalOutputError)}>{text}</div>
  );
}

/**
 * 终端卡：`$` 提示符命令 + 复制按钮 + 输出，统一收进一个带边框的容器。
 * 走项目自身的 cssVar 配色（不引入外部风格元素），与其它工具卡片观感一致。
 */
function TerminalCard({
  command,
  output,
  isError,
  running,
}: {
  command: string;
  output: string;
  isError?: boolean;
  running?: boolean;
}) {
  const styles = cardStyles;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!command) return;
    void navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className={styles.terminalCard}>
      {command ? (
        <div className={styles.terminalHead}>
          <span className={styles.terminalPrompt}>$</span>
          <span className={styles.terminalCommandText}>{command}</span>
          <button type="button" className={styles.terminalCopy} title="复制命令" onClick={copy}>
            <Icon icon={copied ? Check : Copy} size={13} />
          </button>
        </div>
      ) : null}
      {output ? (
        <div
          className={cx(
            styles.terminalBody,
            command && styles.terminalBodyDivided,
            isError && styles.terminalOutputError,
          )}
        >
          {output}
        </div>
      ) : running ? (
        <div
          className={cx(styles.terminalBody, command && styles.terminalBodyDivided, styles.terminalRunning)}
        >
          运行中…
        </div>
      ) : null}
    </div>
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
  const styles = cardStyles;
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
      <TerminalCard
        command={command}
        output={text}
        isError={isError}
        running={status === 'running'}
      />
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

  if (name === 'grep' || name === 'ripgrep') {
    if (status === 'running' && !text) return <TerminalOutput text="搜索中…" />;
    return <GrepCard result={result} />;
  }

  if (name === 'glob') {
    if (status === 'running' && !text) return <TerminalOutput text="搜索中…" />;
    return <GlobCard result={result} />;
  }

  if (name === 'code_search') {
    if (status === 'running' && !text) return <TerminalOutput text="搜索中…" />;
    return <CodeSearchCard result={result} />;
  }

  if (name === 'ls' || name === 'list_dir') {
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
  const styles = cardStyles;
  const [expanded, setExpanded] = useState(status === 'running');
  const hasDetail = useMemo(() => {
    if (status === 'running') return true;
    return Boolean(extractText(result) || getDiff(result) || stringifyJson(result));
  }, [result, status]);

  // todo / generate_image：作为独立卡片常驻展示，不包进可折叠的 Accordion——todo 要常看；生图卡自成
  // 一体（自带标题/提示词/操作/预览），再套通用「工具行 + 折叠 + 引导线 + 虚线分隔」反而冗余难看。
  // 在 hooks 之后再 early return，保证 hooks 调用顺序稳定。
  const bareName = toolName.toLowerCase();

  // ask_user：运行中 → 内联选择卡（接管 InlineQuestionCard）；完成 → 紧凑问答摘要。
  if (bareName === 'ask_user') {
    if (status === 'done') {
      return <AnsweredQuestionsCard args={args} result={result} />;
    }
    return <InlineQuestionCard />;
  }

  if (bareName === 'todo' || bareName === 'generate_image') {
    const card = renderExtensionCard({ toolName, args, result, status });
    if (card) {
      return (
        <div className={styles.toolRow}>
          <ErrorBoundary>{card}</ErrorBoundary>
        </div>
      );
    }
  }

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
            paddingInline={0}
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
        <AccordionItem itemKey="tool" paddingBlock={4} paddingInline={0} title={inspector}>
          <div className={styles.detailGuide}>
            <ScrollArea disableContentFit scrollFade viewportProps={{ className: styles.detailScroll }}>
              <Flexbox gap={8} paddingBlock={8} style={{ minWidth: 0 }}>
                <ToolDetail toolName={toolName} args={args} result={result} status={status} />
                <div className={styles.divDash} />
              </Flexbox>
            </ScrollArea>
          </div>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

// memo：工具卡片只在自身 args/result/status 变化时重渲染。store 对未变消息保持引用稳定，
// 故流式中其他消息更新时，本卡片不会被动重渲染（避免每帧重解析 result）。
export const ToolExecution = memo(ToolExecutionInner);
