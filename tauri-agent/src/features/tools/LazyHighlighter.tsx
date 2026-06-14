import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react';

const Highlighter = lazy(() =>
  import('@lobehub/ui').then((m) => ({ default: m.Highlighter })),
);

type HighlighterProps = ComponentProps<typeof Highlighter>;

function PlainFallback({ children }: { children: ReactNode }) {
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
      {children}
    </pre>
  );
}

export function LazyHighlighter(props: HighlighterProps) {
  return (
    <Suspense fallback={<PlainFallback>{props.children}</PlainFallback>}>
      <Highlighter {...props} />
    </Suspense>
  );
}
