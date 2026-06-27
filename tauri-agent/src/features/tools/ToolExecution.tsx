import { Flexbox } from '@lobehub/ui';
import { Globe, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { CodeSurface } from '../chat/conv/CodeSurface';
import { ConvRow } from '../chat/conv/ConvRow';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { InlineQuestionCard } from '../chat/InlineQuestionCard';
import { AnsweredQuestionsCard } from './AnsweredQuestionsCard';
import { LazyHighlighter } from './LazyHighlighter';
import { CodeSearchCard, GlobCard, GrepCard } from './SearchCards';
import { cardStyles } from './cardStyles';
import { renderExtensionCard } from './extensionCards';
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
  status: ConvStatus;
}

/** 查询词高亮片段；无查询词时回退工具名。 */
function queryFrag(query: string, fallback: string): ReactNode {
  return query ? (
    <span className={cardStyles.queryHighlight}>{query}</span>
  ) : (
    <span className={cardStyles.toolName}>{fallback}</span>
  );
}

/**
 * 由工具名/参数/结果推导 ConvRow 的标题片段：富标题（技能/搜索/检索/读页）整体放进 `name`
 * （保留「搜索：词（N）」「使用技能 X」等既有格式），通用工具走「name=工具名 + args=摘要」。
 */
function toolTitle(
  toolName: string,
  args: unknown,
  result: unknown,
  status: ConvStatus,
): { icon: LucideIcon; name: ReactNode; args?: ReactNode } {
  const c = cardStyles;
  const lname = toolName.toLowerCase();

  // read 一个 SKILL.md = 调用技能：读作「使用技能 <name>」。
  const skillName = skillNameFromRead(toolName, args);
  if (skillName) {
    return { icon: Sparkles, name: <>使用技能 <span className={c.skillName}>{skillName}</span></> };
  }

  if (lname === 'web_search' || lname === 'search') {
    const query = getArgString(args, 'query');
    const details = getDetails(result);
    const countRaw = details?.count;
    const count =
      typeof countRaw === 'number'
        ? countRaw
        : Array.isArray(details?.results)
          ? (details!.results as unknown[]).length
          : undefined;
    return {
      icon: Search,
      name: (
        <>
          搜索：{queryFrag(query, lname)}
          {count != null ? <span className={c.searchCount}>（{count}）</span> : null}
        </>
      ),
    };
  }

  if (lname === 'fetch_url') {
    return {
      icon: Globe,
      name: <>读取页面内容：<span className={c.paramValue}>{getArgString(args, 'url')}</span></>,
    };
  }

  if (lname === 'grep' || lname === 'ripgrep') {
    const total = status === 'running' ? undefined : parseGrepOutput(extractText(result)).total;
    return {
      icon: Search,
      name: (
        <>
          检索 {queryFrag(getArgString(args, 'pattern'), lname)}
          {total != null ? <span className={c.searchCount}> · {total} 处</span> : null}
        </>
      ),
    };
  }
  if (lname === 'glob') {
    const n = status === 'running' ? undefined : parseGlobOutput(extractText(result)).files.length;
    return {
      icon: Search,
      name: (
        <>
          查找文件 {queryFrag(getArgString(args, 'pattern'), lname)}
          {n != null ? <span className={c.searchCount}> · {n} 个</span> : null}
        </>
      ),
    };
  }
  if (lname === 'code_search') {
    const n = status === 'running' ? undefined : parseCodeSearchHits(result).length;
    return {
      icon: Search,
      name: (
        <>
          代码检索 {queryFrag(getArgString(args, 'query'), lname)}
          {n != null ? <span className={c.searchCount}> · {n} 处</span> : null}
        </>
      ),
    };
  }

  // bash 类：命令进 args（去掉终端卡的 $ 提示符与命令重复）。
  if (lname === 'bash' || lname === 'shell' || lname === 'run_terminal_cmd') {
    return { icon: toolMeta(toolName).icon, name: toolName, args: getArgString(args, 'command') || undefined };
  }

  const { icon } = toolMeta(toolName);
  return { icon, name: toolName, args: argSummary(args) || undefined };
}

function TerminalOutput({ text, isError }: { text: string; isError?: boolean }) {
  if (!text) return null;
  return <CodeSurface isError={isError}>{text}</CodeSurface>;
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
  status: ConvStatus;
}) {
  const styles = cardStyles;
  const extensionCard = renderExtensionCard({ toolName, args, result, status });
  if (extensionCard) {
    return (
      <ErrorBoundary>
        <div style={{ marginBlockStart: 2 }}>{extensionCard}</div>
      </ErrorBoundary>
    );
  }
  const name = toolName.toLowerCase();
  const text = extractText(result);
  const diff = getDiff(result);
  const isError = status === 'error';

  // bash：命令已在行内，body 只放输出（去冗余）。
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
    if (status === 'running' && !text) return <CodeSurface>运行中…</CodeSurface>;
    return <CodeSurface isError={isError}>{text || '(无输出)'}</CodeSurface>;
  }

  if (name === 'read' || name === 'read_file') {
    const path = getArgString(args, 'path');
    const lang = langByPath(path);
    return (
      <Flexbox gap={8}>
        {path && <div className={styles.pathLabel}>{path}</div>}
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
        {path && <div className={styles.pathLabel}>{path}</div>}
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
          {path && <div className={styles.pathLabel}>{path}</div>}
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
        {path && <div className={styles.pathLabel}>{path}</div>}
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
    if (status === 'running' && !text) return <CodeSurface>搜索中…</CodeSurface>;
    return <GrepCard result={result} />;
  }
  if (name === 'glob') {
    if (status === 'running' && !text) return <CodeSurface>搜索中…</CodeSurface>;
    return <GlobCard result={result} />;
  }
  if (name === 'code_search') {
    if (status === 'running' && !text) return <CodeSurface>搜索中…</CodeSurface>;
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
  const [expanded, setExpanded] = useState(status === 'running');
  const hasDetail = useMemo(() => {
    if (status === 'running') return true;
    return Boolean(extractText(result) || getDiff(result) || stringifyJson(result));
  }, [result, status]);

  const bareName = toolName.toLowerCase();

  // ask_user：运行中 → 内联选择卡；完成 → 紧凑问答摘要。
  if (bareName === 'ask_user') {
    if (status === 'done') return <AnsweredQuestionsCard args={args} result={result} />;
    return <InlineQuestionCard />;
  }

  // todo / generate_image：作为独立卡片常驻展示，不套通用工具行。
  if (bareName === 'todo' || bareName === 'generate_image') {
    const card = renderExtensionCard({ toolName, args, result, status });
    if (card) {
      return (
        <div className={cardStyles.toolRow}>
          <ErrorBoundary>{card}</ErrorBoundary>
        </div>
      );
    }
  }

  const title = toolTitle(toolName, args, result, status);
  const canExpand = hasDetail || status === 'running';

  return (
    <div className={cardStyles.toolRow}>
      <ConvRow
        data-testid="tool-execution"
        status={status}
        icon={title.icon}
        name={title.name}
        args={title.args}
        open={expanded}
        onToggle={canExpand ? () => setExpanded((v) => !v) : undefined}
        body={
          canExpand ? (
            <ErrorBoundary>
              <ToolDetail toolName={toolName} args={args} result={result} status={status} />
            </ErrorBoundary>
          ) : undefined
        }
      />
    </div>
  );
}

// memo：工具卡片只在自身 args/result/status 变化时重渲染。
export const ToolExecution = memo(ToolExecutionInner);
