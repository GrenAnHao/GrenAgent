import { cssVar } from 'antd-style';
import { FilePlus, Globe, ListChecks, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { normalizeTodos, todoSummary } from '@extensions/_shared/todo-model';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { CodeSurface } from '../chat/conv/CodeSurface';
import { ConvRow } from '../chat/conv/ConvRow';
import { TerminalBlock } from '../chat/conv/TerminalBlock';
import { bashRowSummary } from './bashCardModel';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { PromptPendingRow } from '../chat/PromptPendingRow';
import { todoRowCopy } from '../chat/input/todoRow';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';
import { AnsweredQuestionsCard, parseAnswers } from './AnsweredQuestionsCard';
import { FileDiffBlock } from './FileDiffBlock';
import { FileReadBlock } from './FileReadBlock';
import { fileCardVerb, fileDiffModel, isFileMutation, isFileRead, mutationPath } from './fileDiffModel';
import { LazyHighlighter } from './LazyHighlighter';
import { GlobCard, GrepCard } from './SearchCards';
import { cardStyles } from './cardStyles';
import { renderExtensionCard } from './extensionCards';
import {
  argSummary,
  extractText,
  fileNameFromPath,
  getArgString,
  getDetails,
  getDiff,
  skillNameFromRead,
  stringifyJson,
  toolMeta,
} from './toolUtils';
import { parseGlobOutput, parseGrepOutput } from '../../lib/searchResults';

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

function DiffMeta({ added, deleted }: { added: number; deleted: number }) {
  return (
    <>
      <span style={{ color: cssVar.colorSuccess }}>+{added}</span>{' '}
      <span style={{ color: cssVar.colorError }}>-{deleted}</span>
    </>
  );
}

function presentedFiles(args: unknown, result: unknown): { path: string; description?: string }[] {
  const details = getDetails(result);
  const fromDetails = details?.files;
  const fromArgs = args && typeof args === 'object' ? (args as { files?: unknown }).files : undefined;
  const raw = Array.isArray(fromDetails) ? fromDetails : Array.isArray(fromArgs) ? fromArgs : [];
  const out: { path: string; description?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path !== 'string' || !path) continue;
    const description = (item as { description?: unknown }).description;
    out.push({
      path,
      ...(typeof description === 'string' ? { description } : {}),
    });
  }
  return out;
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
): { icon: LucideIcon; name: ReactNode; args?: ReactNode; meta?: ReactNode } {
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
  // bash 类：外层显示「这条命令在做什么」，展开卡片才给真实命令。
  if (lname === 'bash' || lname === 'shell' || lname === 'run_terminal_cmd') {
    return { icon: toolMeta(toolName).icon, name: toolName, args: bashRowSummary(args) || undefined };
  }

  const { icon } = toolMeta(toolName);
  const verb = fileCardVerb(toolName);
  if (verb && !skillNameFromRead(toolName, args)) {
    const path = mutationPath(args);
    const diff = verb === '读取' ? null : fileDiffModel(toolName, args, result, status);
    return {
      icon,
      name: verb,
      args: path ? fileNameFromPath(path) : undefined,
      meta: diff ? <DiffMeta added={diff.added} deleted={diff.deleted} /> : undefined,
    };
  }
  if (lname === 'present') {
    const files = presentedFiles(args, result);
    const label = files[0] ? fileNameFromPath(files[0].path) : undefined;
    const details = getDetails(result);
    const errorRaw = extractText(result) || (details?.error != null ? String(details.error) : '');
    const errorLine = errorRaw.trim().split(/\r?\n/, 1)[0] || undefined;
    return {
      icon: FilePlus,
      name: status === 'error' ? '交付失败' : '交付文件',
      args:
        status === 'error'
          ? errorLine
          : status === 'running'
            ? '正在交付'
            : files.length > 1
              ? `${files.length} 个文件`
              : label,
    };
  }
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
  workspace,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  status: ConvStatus;
  workspace?: string;
}) {
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
  const isError = status === 'error';

  // bash：展开卡 = 命令横幅 + 流式输出（外层摘要是 description，不在这里重复命令）。
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
    return (
      <TerminalBlock
        command={getArgString(args, 'command')}
        cwd={workspace}
        output={text}
        running={status === 'running'}
        isError={isError}
      />
    );
  }

  if (isFileRead(name)) {
    if (!text) return status === 'running' ? null : <TerminalOutput text={stringifyJson(result)} isError={isError} />;
    return <FileReadBlock path={mutationPath(args)} text={text} />;
  }
  if (isFileMutation(name)) {
    const diff = fileDiffModel(toolName, args, result, status);
    if (!diff) {
      return text || isError ? <TerminalOutput text={text || stringifyJson(result)} isError={isError} /> : null;
    }
    return <FileDiffBlock path={diff.path} rows={diff.rows} added={diff.added} deleted={diff.deleted} />;
  }

  if (name === 'grep' || name === 'ripgrep') {
    if (status === 'running' && !text) return <CodeSurface>搜索中…</CodeSurface>;
    return <GrepCard result={result} />;
  }
  if (name === 'glob') {
    if (status === 'running' && !text) return <CodeSurface>搜索中…</CodeSurface>;
    return <GlobCard result={result} />;
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
  const { workspace } = useAgentStoreContext();
  const hasPendingQuestion = useInlineQuestionStore((s) => Boolean(s.byWorkspace[workspace]));
  const [expanded, setExpanded] = useState(status === 'running');
  const bareName = toolName.toLowerCase();
  const isShell = bareName === 'bash' || bareName === 'shell' || bareName === 'run_terminal_cmd';
  const hasDetail = useMemo(() => {
    if (isFileRead(toolName) && status === 'running' && !extractText(result)) return false;
    if (isFileMutation(toolName) && fileDiffModel(toolName, args, result, status)) return true;
    if (status === 'running') return true;
    if (isShell && getArgString(args, 'command')) return true;
    return Boolean(extractText(result) || getDiff(result) || stringifyJson(result));
  }, [args, isShell, result, status, toolName]);

  // ask_user：运行中 → 工具行占位；完成 → 紧凑问答摘要。浮层由 ComposerPromptOverlay 渲染。
  if (bareName === 'ask_user') {
    if (status === 'done') {
      if (parseAnswers(result).length === 0) {
        return <PromptPendingRow data-testid="ask-user-cancelled" label="已取消" />;
      }
      return <AnsweredQuestionsCard args={args} result={result} />;
    }
    if (status === 'running' && hasPendingQuestion) {
      return <PromptPendingRow data-testid="ask-user-pending" label="等待你选择" live />;
    }
    return null;
  }

  // show_visual / read_visual_choice：UI 通过 VisualCard 呈现，工具行仅显示标题行，不展开 body。
  if (bareName === 'show_visual' || bareName === 'read_visual_choice') {
    const vtitle = toolTitle(toolName, args, result, status);
    return (
      <div className={cardStyles.toolRow}>
        <ConvRow
          data-testid="tool-execution"
          status={status}
          icon={vtitle.icon}
          name={vtitle.name}
          args={vtitle.args}
        />
      </div>
    );
  }

  if (bareName === 'present') {
    const ptitle = toolTitle(toolName, args, result, status);
    return (
      <div className={cardStyles.toolRow}>
        <ConvRow
          data-testid="tool-execution"
          status={status}
          icon={ptitle.icon}
          name={ptitle.name}
          args={ptitle.args}
        />
      </div>
    );
  }

  if (bareName === 'todo') {
    const details = getDetails(result);
    const failed = status === 'error' || details?.error != null;
    const normalized = !failed && details ? normalizeTodos(details) : null;
    const copy = normalized ? todoRowCopy(todoSummary(normalized.todos)) : null;
    return (
      <div className={cardStyles.toolRow}>
        <ConvRow
          data-testid="tool-execution"
          status={failed ? 'error' : status}
          icon={ListChecks}
          name="更新任务清单"
          args={failed ? (extractText(result) || String(details?.error ?? '')) : copy?.args}
          meta={failed ? undefined : copy?.meta}
        />
      </div>
    );
  }

  // generate_image：作为独立卡片常驻展示，不套通用工具行。
  if (bareName === 'generate_image') {
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
  const canExpand = hasDetail;

  return (
    <div className={cardStyles.toolRow}>
      <ConvRow
        data-testid="tool-execution"
        status={status}
        icon={title.icon}
        name={title.name}
        args={title.args}
        meta={title.meta}
        open={expanded}
        onToggle={canExpand ? () => setExpanded((v) => !v) : undefined}
        body={
          canExpand ? (
            <ErrorBoundary>
              <ToolDetail
                toolName={toolName}
                args={args}
                result={result}
                status={status}
                workspace={workspace}
              />
            </ErrorBoundary>
          ) : undefined
        }
      />
    </div>
  );
}

// memo：工具卡片只在自身 args/result/status 变化时重渲染。
export const ToolExecution = memo(ToolExecutionInner);
