import { lazy, Suspense, type ComponentProps } from 'react';

const Markdown = lazy(() => import('@lobehub/ui').then((m) => ({ default: m.Markdown })));

type MarkdownProps = ComponentProps<typeof Markdown>;

export function LazyMarkdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{props.children}</span>}>
      <Markdown {...props} />
    </Suspense>
  );
}
