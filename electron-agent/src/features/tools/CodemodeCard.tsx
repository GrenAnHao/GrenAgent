import { createStaticStyles, cssVar } from 'antd-style';
import { Ban, Plug, Wrench } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { ToolSegment } from '../chat/groupMessages';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { CodeSurface } from '../chat/conv/CodeSurface';
import { ConvRow } from '../chat/conv/ConvRow';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { CodeCard, codeCardContentClass } from './CodeCard';
import { FileImageRead } from './FileImageRead';
import { LazyHighlighter } from './LazyHighlighter';
import {
  callLabel,
  codemodeCode,
  detectResultFormat,
  formatCallDuration,
  mcpToolParts,
  parseCodemodeOutput,
  prettyJson,
  splitFullOutput,
  toolArgsSummary,
  type CodemodeCall,
  type CodemodeCallItem,
} from './codemodeModel';
import { extractContentImages, extractText } from './toolUtils';

/** 收起时最多露出几条调用；运行中露最新的几条，前面的折成一行。 */
const VISIBLE_CALLS = 6;

const codeStyle = { fontFamily: 'var(--pi-font-mono)', fontSize: 12.5 } as const;

const styles = createStaticStyles(({ css }) => ({
  calls: css`
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    margin-block: 0 4px;
    margin-inline-start: 11px;
    padding-inline-start: 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  call: css`
    min-width: 0;
  `,
  more: css`
    align-self: flex-start;
    height: 24px;
    padding: 0 6px;
    margin-inline-start: -6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorTextSecondary};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  serverTag: css`
    display: inline-block;
    margin-inline-end: 6px;
    padding: 0 5px;
    border-radius: 4px;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    line-height: 17px;
    vertical-align: 1px;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  sectionHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  muted: css`
    font-size: 12px;
    color: ${cssVar.colorTextQuaternary};
  `,
  footnote: css`
    overflow: hidden;
    min-width: 0;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  mdBox: css`
    overflow: auto;
    max-height: min(50vh, 360px);
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
  `,
}));

/** 工具名：MCP 工具拆成「服务器标签 + 工具名」，其余原样。 */
export function ToolNameLabel({ name }: { name: string }) {
  const parts = mcpToolParts(name);
  if (!parts) return <>{name}</>;
  return (
    <>
      <span className={styles.serverTag} data-role="mcp-server">
        {parts.server}
      </span>
      <span>{parts.tool}</span>
    </>
  );
}

function convStatus(status: CodemodeCall['status']): ConvStatus {
  if (status === 'ok') return 'done';
  if (status === 'running') return 'running';
  return 'error';
}

/** 只有 details.calls 记录的一条调用（历史回放、models.* 调用）：不能展开看结果，失败时可以看错误。 */
const CallRecordRow = memo(function CallRecordRow({ call }: { call: CodemodeCall }) {
  const [open, setOpen] = useState(false);
  const meta = [
    call.status === 'cancelled' ? '已取消' : '',
    call.durationMs != null ? formatCallDuration(call.durationMs) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <ConvRow
      data-testid="tool-execution"
      status={convStatus(call.status)}
      icon={call.status === 'cancelled' ? Ban : mcpToolParts(call.name) ? Plug : Wrench}
      name={<ToolNameLabel name={call.name} />}
      args={toolArgsSummary(call.args) || undefined}
      meta={meta || undefined}
      open={open}
      onToggle={call.error ? () => setOpen((v) => !v) : undefined}
      body={call.error ? <CodeSurface isError>{call.error}</CodeSurface> : undefined}
    />
  );
});

/**
 * codemode 卡下面常驻的嵌套调用列表：实时段交给 renderLive（就是普通工具行，可展开看结果），
 * 只有记录的行用 CallRecordRow。超过 VISIBLE_CALLS 条时只露最后几条，前面的折成一行。
 */
export function CodemodeCalls({
  items,
  renderLive,
}: {
  items: CodemodeCallItem[];
  /** durationMs：配上的 details.calls 记录里的耗时，没有就用段自己的。 */
  renderLive: (segment: ToolSegment, durationMs?: number) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;
  const hidden = showAll || items.length <= VISIBLE_CALLS ? 0 : items.length - (VISIBLE_CALLS - 1);
  const shown = hidden > 0 ? items.slice(hidden) : items;
  return (
    <div className={styles.calls} data-testid="codemode-calls">
      {hidden > 0 ? (
        <button type="button" className={styles.more} data-testid="codemode-calls-more" onClick={() => setShowAll(true)}>
          前面还有 {hidden} 次调用
        </button>
      ) : null}
      {shown.map((item) => (
        <div
          key={item.key}
          className={styles.call}
          data-testid="codemode-call"
          data-status={item.status}
          data-live={item.kind === 'live' ? '1' : undefined}
          title={callLabel(item.name)}
        >
          {item.kind === 'live' ? renderLive(item.segment, item.durationMs) : <CallRecordRow call={item.call} />}
        </div>
      ))}
    </div>
  );
}

function JsonCard({ text, label = 'JSON' }: { text: string; label?: string }) {
  return (
    <CodeCard language="json" label={label} maxHeight="min(50vh, 320px)">
      <div className={codeCardContentClass}>
        <LazyHighlighter
          copyable={false}
          language="json"
          showLanguage={false}
          variant="borderless"
          style={{ width: '100%' }}
          styles={{ content: codeStyle }}
        >
          {text}
        </LazyHighlighter>
      </div>
    </CodeCard>
  );
}

/** 展开体：脚本（高亮、限高）+ 输出（去掉结果头；JSON 缩进高亮；脚本错误单独标红；图片直接画）。 */
export const CodemodeDetail = memo(function CodemodeDetail({
  args,
  result,
  status,
}: {
  args: unknown;
  result: unknown;
  status: ConvStatus;
}) {
  const code = codemodeCode(args);
  const output = useMemo(() => parseCodemodeOutput(result), [result]);
  const images = useMemo(() => extractContentImages(result), [result]);
  const lines = code ? code.replace(/\s+$/, '').split(/\r?\n/).length : 0;
  const empty = output.blocks.length === 0 && images.length === 0;

  // 输出在前、脚本在后：失败时先看到错误，脚本只是备查。
  return (
    <div className={styles.stack} data-testid="codemode-detail">
      <div className={styles.stack} data-testid="codemode-output">
        <div className={styles.sectionHead}>
          <span>输出</span>
          {output.wallMs != null ? <span className={styles.muted}>脚本耗时 {formatCallDuration(output.wallMs)}</span> : null}
        </div>
        {empty ? (
          <span className={styles.muted}>{status === 'running' ? '运行中…' : '无输出'}</span>
        ) : null}
        {output.blocks.map((block, index) =>
          block.kind === 'json' ? (
            <div key={index} data-block="json">
              <JsonCard text={block.text} />
            </div>
          ) : block.kind === 'console' ? (
            <div key={index} className={styles.stack} data-block="console">
              <span className={styles.muted}>控制台</span>
              <CodeSurface>{block.text}</CodeSurface>
            </div>
          ) : block.kind === 'error' ? (
            <div key={index} data-block="error" data-testid="codemode-error">
              <CodeSurface isError>{block.text}</CodeSurface>
            </div>
          ) : (
            <div key={index} data-block="text">
              <CodeSurface>{block.text}</CodeSurface>
            </div>
          ),
        )}
        {images.length > 0 ? <FileImageRead alt="脚本输出图片" images={images} /> : null}
        {output.fullOutputPath ? (
          <div className={styles.footnote} title={output.fullOutputPath}>
            完整输出：{output.fullOutputPath}
          </div>
        ) : null}
      </div>
      {code ? (
        <div data-testid="codemode-script">
          <CodeCard language="javascript" label="脚本" extra={`${lines} 行`} maxHeight="min(40vh, 260px)">
            <div className={codeCardContentClass}>
              <LazyHighlighter
                copyable={false}
                language="javascript"
                showLanguage={false}
                variant="borderless"
                style={{ width: '100%' }}
                styles={{ content: codeStyle }}
              >
                {code}
              </LazyHighlighter>
            </div>
          </CodeCard>
        </div>
      ) : null}
    </div>
  );
});

/** MCP 工具的展开体：去掉「全文: 路径」尾巴单独成行；JSON 缩进高亮，markdown 渲染，其余等宽文本。 */
export const McpResultBody = memo(function McpResultBody({
  result,
  status,
}: {
  result: unknown;
  status: ConvStatus;
}) {
  const text = extractText(result);
  const images = useMemo(() => extractContentImages(result), [result]);
  const { body, fullPath } = useMemo(() => splitFullOutput(text), [text]);
  const format = useMemo(() => (status === 'error' ? 'text' : detectResultFormat(body)), [body, status]);
  if (status === 'running' && !text && images.length === 0) return <CodeSurface>调用中…</CodeSurface>;

  let content: ReactNode = null;
  if (body.trim()) {
    if (format === 'json') content = <JsonCard text={prettyJson(body) ?? body} />;
    else if (format === 'markdown') {
      content = (
        <div className={styles.mdBox}>
          <LazyMarkdown variant="chat" tone="secondary" enableMermaid={false}>
            {body}
          </LazyMarkdown>
        </div>
      );
    } else content = <CodeSurface isError={status === 'error'}>{body}</CodeSurface>;
  } else if (images.length === 0) {
    content = <span className={styles.muted}>无输出</span>;
  }

  return (
    <div className={styles.stack} data-testid="mcp-result" data-format={format}>
      {content ? <div data-testid="mcp-result-body">{content}</div> : null}
      {images.length > 0 ? <FileImageRead alt="MCP 图片" images={images} /> : null}
      {fullPath ? (
        <div className={styles.footnote} data-testid="mcp-full-output" title={fullPath}>
          全文：{fullPath}
        </div>
      ) : null}
    </div>
  );
});
