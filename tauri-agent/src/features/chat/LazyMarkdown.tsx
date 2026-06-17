import { lazy, memo, Suspense, type ComponentProps } from 'react';

const Markdown = lazy(() => import('@lobehub/ui').then((m) => ({ default: m.Markdown })));

type MarkdownProps = ComponentProps<typeof Markdown>;

function LazyMarkdownInner(props: MarkdownProps) {
  return (
    <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{props.children}</span>}>
      <Markdown {...props} />
    </Suspense>
  );
}

// memo：正文（children=text）等 props 不变时不重渲染，避免流式中未变消息反复解析 markdown。
export const LazyMarkdown = memo(LazyMarkdownInner);
