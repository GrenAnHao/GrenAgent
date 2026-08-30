import { Component, lazy, memo, Suspense, type ComponentProps, type ReactNode } from 'react';

import { Mermaid } from './Mermaid';
import { splitMermaid } from './splitMermaid';
import { stripInlineImages } from './splitDataImages';

const Markdown = lazy(() => import('@lobehub/ui').then((m) => ({ default: m.Markdown })));

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

// 正文块：始终关掉 @lobehub 的 mermaid（blob image）路径——mermaid 由本文件分段后交给自写组件渲染。
function MarkdownBlock(props: Omit<MarkdownProps, 'enableMermaid'>) {
  const plain: ReactNode = props.children as ReactNode;
  return (
    <MarkdownErrorBoundary fallback={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{plain}</pre>}>
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
          <Mermaid code={segment.content} key={`mermaid-${index}`} streaming={rest.animated} />
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
function LazyMarkdownInner({ enableMermaid = true, children, ...rest }: MarkdownProps) {
  if (typeof children !== 'string') {
    return <MarkdownBlock {...rest}>{children}</MarkdownBlock>;
  }
  return <>{renderMermaidAware(stripInlineImages(children), enableMermaid, rest)}</>;
}

// memo：props 不变时不重渲染，避免流式中未变消息反复解析 markdown。
export const LazyMarkdown = memo(LazyMarkdownInner);
