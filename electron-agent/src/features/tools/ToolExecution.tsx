import { cssVar } from 'antd-style';
import { Braces, FilePlus, Globe, ListChecks, Plug, Search, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react';
import { normalizeTodos, todoSummary } from '@extensions/_shared/todo-model';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { CodeSurface } from '../chat/conv/CodeSurface';
import { ConvRow } from '../chat/conv/ConvRow';
import { TerminalBlock } from '../chat/conv/TerminalBlock';
import {
  bashJobRef,
  bashRowSummary,
  bashSandboxFacts,
  bashSandboxMeta,
  bashSandboxNote,
  foregroundJobRef,
  jobRowStatus,
  jobTiming,
} from './bashCardModel';
import { BashJobMeta, BashJobTerminal } from './BashJobTerminal';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { PromptPendingRow } from '../chat/PromptPendingRow';
import { todoRowCopy } from '../chat/input/todoRow';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useJobLive } from '../../stores/jobLiveStore';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';
import { AnsweredQuestionsCard, parseAnswers } from './AnsweredQuestionsCard';
import { FileDiffBlock } from './FileDiffBlock';
import { StreamingCodeView } from './StreamingCodeView';
import { StreamingFileBody } from './StreamingFileBody';
import { exceedsHighlightBudget, streamingEditPairs, streamingEditStats, streamingWritePreview, writeContent } from './streamingFileModel';
import { FileImageRead } from './FileImageRead';
import { FileReadBlock } from './FileReadBlock';
import { fileCardVerb, fileDiffModel, isFileMutation, isFileRead, mutationPath, readLineRange } from './fileDiffModel';
import { LazyHighlighter } from './LazyHighlighter';
import { RunDuration } from './RunDuration';
import { CodeSearchCard, GlobCard, GrepCard } from './SearchCards';
import { cardStyles } from './cardStyles';
import { CodemodeCalls, CodemodeDetail, McpResultBody, ToolNameLabel } from './CodemodeCard';
import {
  codemodeCallSummary,
  codemodeCalls,
  codemodeCode,
  firstCodeLine,
  formatCallDuration,
  isCodemodeTool,
  isMcpTool,
  mergeCodemodeCalls,
  parseCodemodeOutput,
  toolArgsSummary,
  type CodemodeCallItem,
} from './codemodeModel';
import { renderExtensionCard } from './extensionCards';
import { parseInvalidArguments, type InvalidArguments } from './invalidArgumentsModel';
import type { ToolSegment } from '../chat/groupMessages';
import {
  argSummary,
  extractContentImages,
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
  /** false = 参数仍在生成。缺省视为完整。 */
  argsComplete?: boolean;
  /** 开始执行的时刻；命令行卡片据此在标题右侧实时计时。 */
  startedAt?: number;
  /** 执行耗时（ms），结束后定格显示。 */
  durationMs?: number;
  /** 挂在本工具下的嵌套调用（codemode 脚本里的 tools.* 调用）。 */
  nested?: ToolSegment[];
}

function codeSearchPatterns(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  // 新 schema 是必填 pattern + 可选 patterns；旧会话只有 patterns 数组。两种都要能显示。
  const { pattern, patterns } = args as { pattern?: unknown; patterns?: unknown };
  const list = [pattern, ...(Array.isArray(patterns) ? patterns : [patterns])];
  return [...new Set(list.filter((item): item is string => typeof item === 'string' && item.length > 0))].join(' | ');
}

function codeSearchTotal(result: unknown): number | undefined {
  const total = getDetails(result)?.total;
  return typeof total === 'number' ? total : undefined;
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
  argsStreaming = false,
  /** running 只给后台 bash 用：行状态跟着后台任务走时，时长是否还在自增。 */
  timing: { startedAt?: number; durationMs?: number; running?: boolean } = {},
): { icon: LucideIcon; name: ReactNode; args?: ReactNode; meta?: ReactNode; metaInline?: boolean } {
  const c = cardStyles;
  const lname = toolName.toLowerCase();

  // read 一个 SKILL.md = 调用技能：读作「使用技能 <name>」。
  const skillName = skillNameFromRead(toolName, args);
  if (skillName) {
    return { icon: Sparkles, name: <>使用技能 <span className={c.skillName}>{skillName}</span></> };
  }

  if (lname === 'search') {
    const patterns = codeSearchPatterns(args);
    const failed = status !== 'running' && extractText(result).startsWith('search:');
    const total = status === 'running' || failed ? undefined : codeSearchTotal(result);
    return {
      icon: Search,
      name: (
        <>
          检索{patterns ? <> {queryFrag(patterns, '')}</> : null}
          {total != null ? <span className={c.searchCount}> · {total} 处</span> : null}
        </>
      ),
    };
  }

  if (lname === 'web_search' || lname === 'web_search_multi') {
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

  if (isMcpTool(toolName)) {
    const duration = status !== 'running' && timing.durationMs != null ? formatCallDuration(timing.durationMs) : '';
    return {
      icon: Plug,
      name: <ToolNameLabel name={toolName} />,
      args: toolArgsSummary(args) || undefined,
      meta: duration || undefined,
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
  // bash 类：外层显示「这条命令在做什么」，展开卡片才给真实命令；时长插在工具名与描述之间。
  if (lname === 'bash' || lname === 'shell' || lname === 'run_terminal_cmd') {
    // 转到后台的命令（run_in_background / 前台超时）：工具调用已结束，状态跟着 job 走。
    const jobRef = status === 'running' ? null : bashJobRef(result);
    // 前台结果里的沙箱事实（details.sandbox）：被拒 / 沙箱没启动 / 已升权。后台任务行跟着 job 走。
    const sandboxMeta = jobRef ? undefined : bashSandboxMeta(bashSandboxFacts(result));
    return {
      icon: toolMeta(toolName).icon,
      name: (
        <>
          <span>{toolName}</span>
          <RunDuration
            startedAt={timing.startedAt}
            durationMs={timing.durationMs}
            running={timing.running ?? status === 'running'}
          />
        </>
      ),
      args: bashRowSummary(args) || undefined,
      meta: jobRef ? (
        <BashJobMeta jobRef={jobRef} />
      ) : sandboxMeta ? (
        <span data-testid="bash-sandbox-meta">{sandboxMeta}</span>
      ) : undefined,
    };
  }

  const { icon } = toolMeta(toolName);
  const verb = fileCardVerb(toolName);
  if (verb && !skillNameFromRead(toolName, args)) {
    const path = mutationPath(args);
    const range = verb === '读取' ? readLineRange(args) : undefined;
    const file = path ? fileNameFromPath(path) : undefined;
    if (argsStreaming && verb !== '读取') {
      let streamingMeta = `生成中 · ${streamingEditPairs(args).length} 处`;
      if (verb === '写入') {
        streamingMeta = `生成中 · ${streamingWritePreview(args).totalLines} 行`;
      } else {
        const stats = streamingEditStats(args);
        const counts = [
          stats.added ? `+${stats.added}` : '',
          stats.deleted ? `-${stats.deleted}` : '',
        ].filter(Boolean);
        if (counts.length) streamingMeta = `生成中 · ${counts.join(' ')}`;
      }
      return {
        icon,
        name: verb,
        args: file ? (range ? `${file} · ${range}` : file) : range,
        meta: streamingMeta,
      };
    }
    const diff = verb === '读取' ? null : fileDiffModel(toolName, args, result, status);
    return {
      icon,
      name: verb,
      args: file ? (range ? `${file} · ${range}` : file) : range,
      meta: diff ? <DiffMeta added={diff.added} deleted={diff.deleted} /> : undefined,
      metaInline: Boolean(diff),
    };
  }
  if (lname === 'add_mcp_server') {
    const server = getArgString(args, 'name') || 'MCP';
    const transport = getArgString(args, 'transport');
    return {
      icon,
      name: '添加 MCP',
      args: transport ? `${server} · ${transport}` : server,
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
  // B 轨：只切换会话目录，权限根还是原始工作区。不要让它看起来像「独立工作区」。
  if (lname === 'create_worktree') {
    const name = getArgString(args, 'name');
    return { icon, name: '切到新 worktree', args: `${name ? `${name} · ` : ''}仍可写原工作区` };
  }
  if (lname === 'working_directory') {
    const cd = getArgString(args, 'cd');
    return { icon, name: cd ? '切换目录' : '当前目录', args: cd || undefined };
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
  argsStreaming = false,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  status: ConvStatus;
  workspace?: string;
  argsStreaming?: boolean;
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
  if (isMcpTool(toolName)) return <McpResultBody result={result} status={status} />;
  const text = extractText(result);
  const isError = status === 'error';

  // bash：展开卡 = 命令横幅 + 流式输出（外层摘要是 description，不在这里重复命令）。
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
    const jobRef = status === 'running' ? null : bashJobRef(result);
    if (jobRef) {
      return (
        <BashJobTerminal
          jobRef={jobRef}
          command={getArgString(args, 'command')}
          cwd={workspace}
          resultText={text}
        />
      );
    }
    // 运行中的前台命令：匠名 job，引用只在 partial 结果里，最终结果不带（下面落到普通终端）。
    const anonymousRef = status === 'running' ? foregroundJobRef(result) : null;
    if (anonymousRef) {
      return (
        <BashJobTerminal
          anonymous
          jobRef={anonymousRef}
          command={getArgString(args, 'command')}
          cwd={workspace}
          resultText={text}
        />
      );
    }
    const sandboxNote = bashSandboxNote(bashSandboxFacts(result));
    return (
      <TerminalBlock
        command={getArgString(args, 'command')}
        cwd={workspace}
        output={text}
        running={status === 'running'}
        isError={isError}
        footer={sandboxNote ? <span data-testid="bash-sandbox-note">{sandboxNote}</span> : undefined}
      />
    );
  }

  if (isFileRead(name)) {
    const images = extractContentImages(result);
    if (images.length > 0) {
      return <FileImageRead alt={fileNameFromPath(mutationPath(args)) || '图片'} images={images} />;
    }
    if (!text) return status === 'running' ? null : <TerminalOutput text={stringifyJson(result)} isError={isError} />;
    return <FileReadBlock path={mutationPath(args)} text={text} />;
  }
  if (isFileMutation(name)) {
    // 写入全是新增行，生成阶段的 diff 没有信息量：先做逐行追加的代码高亮，完成后才上 diff。
    if (argsStreaming && fileCardVerb(toolName) === '写入') {
      const livePath = mutationPath(args);
      const liveContent = writeContent(args);
      if (livePath && liveContent && !exceedsHighlightBudget(liveContent)) {
        return <StreamingCodeView content={liveContent} path={livePath} />;
      }
    }
    if (argsStreaming) return <StreamingFileBody toolName={toolName} args={args} />;
    const diff = fileDiffModel(toolName, args, result, status);
    if (diff && diff.rows.length > 0) {
      return <FileDiffBlock path={diff.path} rows={diff.rows} added={diff.added} deleted={diff.deleted} />;
    }
    return text || isError ? <TerminalOutput text={text || stringifyJson(result)} isError={isError} /> : null;
  }

  if (name === 'search') {
    const details = getDetails(result);
    const hasHits = Array.isArray(details?.matches) && details.matches.length > 0;
    if (status === 'running' && !text && !hasHits) return <CodeSurface>搜索中…</CodeSurface>;
    return <CodeSearchCard result={result} isError={isError} />;
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

function renderNestedTool(segment: ToolSegment, durationMs?: number): ReactNode {
  return (
    <ToolExecution
      toolName={segment.toolName}
      toolCallId={segment.toolCallId}
      args={segment.args}
      result={segment.result}
      status={segment.status}
      argsComplete={segment.argsComplete}
      startedAt={segment.startedAt}
      durationMs={segment.status === 'running' ? segment.durationMs : (durationMs ?? segment.durationMs)}
      nested={segment.children}
    />
  );
}

function codemodeMeta(items: CodemodeCallItem[]): string {
  if (items.length === 0) return '';
  const failed = items.filter((item) => item.status === 'error').length;
  return `${items.length} 次调用${failed ? ` · ${failed} 失败` : ''}`;
}

/**
 * codemode：标题「运行脚本 · 耗时 · 调用了哪些工具」，行下常驻嵌套调用列表（实时段可展开看结果，
 * 历史回放靠 details.calls），展开体是脚本和输出。
 */
const CodemodeExecution = memo(function CodemodeExecution({
  args,
  result,
  status,
  startedAt,
  durationMs,
  nested,
}: ToolExecutionProps) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => mergeCodemodeCalls(codemodeCalls(result), nested), [result, nested]);
  const wallMs = useMemo(() => parseCodemodeOutput(result).wallMs, [result]);
  const code = codemodeCode(args);
  const running = status === 'running';
  const summary = items.length > 0 ? codemodeCallSummary(items.map((item) => item.name)) : firstCodeLine(code);
  const meta = codemodeMeta(items);
  const canExpand = Boolean(code) || running || Boolean(extractText(result));

  return (
    <div className={cardStyles.toolRow} data-testid="codemode-card">
      <ConvRow
        data-testid="tool-execution"
        status={status}
        icon={Braces}
        name={
          <>
            运行脚本
            <RunDuration
              startedAt={startedAt}
              durationMs={running ? undefined : (wallMs ?? durationMs)}
              running={running}
              format={formatCallDuration}
            />
          </>
        }
        args={summary ? <span data-testid="codemode-summary">{summary}</span> : undefined}
        meta={meta ? <span data-testid="codemode-meta">{meta}</span> : undefined}
        open={expanded}
        onToggle={canExpand ? () => setExpanded((v) => !v) : undefined}
        inline={<CodemodeCalls items={items} renderLive={renderNestedTool} />}
        body={
          canExpand ? (
            <ErrorBoundary>
              <CodemodeDetail args={args} result={result} status={status} />
            </ErrorBoundary>
          ) : undefined
        }
      />
    </div>
  );
});

/** 运行中默认展开的只有命令行，方便看流式输出。写入和编辑保持收起。 */
function opensWhileRunning(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === 'bash' || name === 'shell' || name === 'run_terminal_cmd';
}

function ToolExecutionInner(props: ToolExecutionProps) {
  // Before the per-tool cards: their args are `{}` here, so they would show an empty command or path.
  const invalid = props.status === 'error' ? parseInvalidArguments(props.result) : undefined;
  if (invalid) return <InvalidArgumentsExecution toolName={props.toolName} invalid={invalid} />;
  if (isCodemodeTool(props.toolName)) return <CodemodeExecution {...props} />;
  return <PlainToolExecution {...props} />;
}

/** The model sent arguments that are not a JSON object; the tool never ran (pi 1.3.0). */
function InvalidArgumentsExecution({ toolName, invalid }: { toolName: string; invalid: InvalidArguments }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cardStyles.toolRow} data-testid="invalid-arguments-card">
      <ConvRow
        data-testid="tool-execution"
        status="error"
        icon={TriangleAlert}
        name={
          <>
            <ToolNameLabel name={toolName} /> 参数无法解析
          </>
        }
        args={<span data-testid="invalid-arguments-reason">{invalid.reason.split('\n', 1)[0]}</span>}
        meta={<span data-testid="invalid-arguments-meta">未执行</span>}
        open={expanded}
        onToggle={() => setExpanded((v) => !v)}
        body={
          <ErrorBoundary>
            <CodeSurface isError testId="invalid-arguments-reason-full">{invalid.reason}</CodeSurface>
            <CodeSurface testId="invalid-arguments-received">{invalid.received || '（空）'}</CodeSurface>
          </ErrorBoundary>
        }
      />
    </div>
  );
}

function PlainToolExecution({ toolName, args, result, status, argsComplete, startedAt, durationMs }: ToolExecutionProps) {
  const { workspace } = useAgentStoreContext();
  const hasPendingQuestion = useInlineQuestionStore((s) => Boolean(s.byWorkspace[workspace]));
  const [expanded, setExpanded] = useState(status === 'running' && opensWhileRunning(toolName));
  const bareName = toolName.toLowerCase();
  const isShell = bareName === 'bash' || bareName === 'shell' || bareName === 'run_terminal_cmd';
  const argsStreaming = status === 'running' && argsComplete === false;
  const hasDetail = useMemo(() => {
    if (argsStreaming && isFileMutation(toolName)) return true;
    if (isFileRead(toolName) && status === 'running' && !extractText(result)) return false;
    if (isFileMutation(toolName) && fileDiffModel(toolName, args, result, status)) return true;
    if (status === 'running') return true;
    if (isShell && getArgString(args, 'command')) return true;
    return Boolean(extractText(result) || getDiff(result) || stringifyJson(result));
  }, [args, argsStreaming, isShell, result, status, toolName]);
  // 后台 bash：调用本身瞬间返回，行图标和时长要跟着后台任务走，否则还在跑的任务显示成 ✓ 0s。
  const backgroundRef = isShell && status !== 'running' ? bashJobRef(result) : null;
  const backgroundJob = useJobLive(backgroundRef)?.job;
  const rowStatus = jobRowStatus(status, backgroundJob);
  // 前台转后台时快照可能还没到，未知状态不能当完成；历史首次拿到终态也不能关掉手动展开。
  const shellRunning = isShell ? (backgroundRef && !backgroundJob ? null : rowStatus === 'running') : false;
  const wasShellRunning = useRef(shellRunning === true);
  useEffect(() => {
    if (shellRunning === null) return;
    if (wasShellRunning.current && !shellRunning) setExpanded(false);
    wasShellRunning.current = shellRunning;
  }, [shellRunning]);

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

  const title = toolTitle(
    toolName,
    args,
    result,
    status,
    argsStreaming,
    backgroundJob ? jobTiming(backgroundJob) : { startedAt, durationMs },
  );
  const canExpand = hasDetail;

  return (
    <div className={cardStyles.toolRow}>
      <ConvRow
        data-testid="tool-execution"
        status={rowStatus}
        icon={title.icon}
        name={title.name}
        args={title.args}
        meta={title.meta}
        metaInline={title.metaInline}
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
                argsStreaming={argsStreaming}
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
