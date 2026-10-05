import { Component, lazy, memo, Suspense, type ComponentProps, type CSSProperties, type ReactNode } from 'react';

import { MermaidLoading } from './MermaidLoading';
import { splitMermaid } from './splitMermaid';
import { stripInlineImages } from './splitDataImages';

// 经 lobeHeavy 中转再动态导入：直接 import('@lobehub/ui') 会把整包（katex、rehype、elkjs …）留在首包里。
const Markdown = lazy(() => import('../../lib/lobeHeavy').then((m) => ({ default: m.Markdown })));
// Mermaid 带 beautiful-mermaid 和 elkjs，只有正文里出现图表时才加载。
const Mermaid = lazy(() => import('./Mermaid').then((m) => ({ default: m.Mermaid })));

function LazyMermaid(props: { code: string; streaming?: boolean }) {
  return (
    <Suspense fallback={<MermaidLoading />}>
      <Mermaid {...props} />
    </Suspense>
  );
}

type MarkdownProps = ComponentProps<typeof Markdown>;

// 渲染兜底：万一 Markdown 渲染抛错，降级为纯文本，避免整条消息白屏。
class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type LazyMarkdownProps = Omit<MarkdownProps, 'fontSize'> & {
  tone?: 'body' | 'secondary';
  prose?: boolean;
};

function markdownClassName(prose: boolean, tone: 'body' | 'secondary', className?: string): string | undefined {
  const names = [
    prose ? 'pi-md' : null,
    prose && tone === 'secondary' ? 'pi-md-secondary' : null,
    className,
  ].filter(Boolean) as string[];
  return names.length > 0 ? names.join(' ') : undefined;
}

const fallbackPreStyle = {
  margin: 0,
  whiteSpace: 'pre-wrap' as const,
  fontFamily: 'var(--pi-font-sans)',
  fontSize: 'var(--pi-font-size, 14px)',
  lineHeight: 'calc(24px + var(--pi-font-delta, 0px))',
};

// @lobehub 把 --lobe-markdown-font-size / -line-height 写成 <article> 上的行内变量，
// variant="chat" 时恒为 14px / 1.6，会把后代字号钉死（见「动工前必读」）。Typography 里
// `...style` 展开在自有变量之后，用行内 style 指回我们的轴即可。
const LOBE_AXIS_BODY = {
  '--lobe-markdown-font-size': 'var(--pi-font-size, 14px)',
  '--lobe-markdown-line-height': 'calc(24px + var(--pi-font-delta, 0px))',
} as CSSProperties;

const LOBE_AXIS_SECONDARY = {
  '--lobe-markdown-font-size': 'var(--pi-font-size-secondary, 13px)',
  '--lobe-markdown-line-height': 'calc(20px + var(--pi-font-delta-secondary, 0px))',
} as CSSProperties;

// 正文块：始终关掉 @lobehub 的 mermaid（blob image）路径——mermaid 由本文件分段后交给自写组件渲染。
function MarkdownBlock(props: Omit<MarkdownProps, 'enableMermaid'>) {
  const plain: ReactNode = props.children as ReactNode;
  return (
    <MarkdownErrorBoundary fallback={<pre style={fallbackPreStyle}>{plain}</pre>}>
      <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{plain}</span>}>
        <Markdown enableMermaid={false} {...props} />
      </Suspense>
    </MarkdownErrorBoundary>
  );
}

type MarkdownRest = Omit<MarkdownProps, 'enableMermaid' | 'children'>;

// 正文段：默认把 ```mermaid 块切出来用自写 inline-SVG 渲染（绕开 WebView2 对 @lobehub blob image
// 懒加载的拦截），其余仍交给 @lobehub/ui Markdown。
function renderMermaidAware(content: string, enableMermaid: boolean, rest: MarkdownRest): ReactNode {
  if (!enableMermaid) return <MarkdownBlock {...rest}>{content}</MarkdownBlock>;

  const segments = splitMermaid(content);
  if (segments.length === 1 && segments[0].type === 'markdown') {
    return <MarkdownBlock {...rest}>{content}</MarkdownBlock>;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'mermaid' ? (
          <LazyMermaid code={segment.content} key={`mermaid-${index}`} streaming={rest.animated} />
        ) : (
          <MarkdownBlock key={`md-${index}`} {...rest}>
            {segment.content}
          </MarkdownBlock>
        ),
      )}
    </>
  );
}

// 对话里不内联渲染图片：图片统一走 generate_image 工具卡（GenerateImageCard）展示。这里剥掉正文里的
// data-URL 图片、图片请求 JSON 回显，以及本地/相对路径的图片引用（避免裂图 + 与工具卡重复），只渲染正文。
function LazyMarkdownInner({
  enableMermaid = true,
  children,
  tone = 'body',
  prose = true,
  className,
  style,
  ...rest
}: LazyMarkdownProps) {
  const mdClass = markdownClassName(prose, tone, className);
  const axisStyle = tone === 'secondary' ? LOBE_AXIS_SECONDARY : LOBE_AXIS_BODY;
  const blockProps = { ...rest, className: mdClass, style: { ...axisStyle, ...style } };
  if (typeof children !== 'string') {
    return <MarkdownBlock {...blockProps}>{children}</MarkdownBlock>;
  }
  return <>{renderMermaidAware(stripInlineImages(children), enableMermaid, blockProps)}</>;
}

// memo：props 不变时不重渲染，避免流式中未变消息反复解析 markdown。
export const LazyMarkdown = memo(LazyMarkdownInner);
