import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react';

const Highlighter = lazy(() =>
  import('@lobehub/ui').then((m) => ({ default: m.Highlighter })),
);
const SyntaxHighlighter = lazy(() =>
  import('@lobehub/ui').then((m) => ({ default: m.SyntaxHighlighter })),
);

type HighlighterProps = ComponentProps<typeof Highlighter>;
type SyntaxHighlighterProps = ComponentProps<typeof SyntaxHighlighter>;

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

export function LazySyntaxHighlighter(props: SyntaxHighlighterProps) {
  return (
    <Suspense fallback={<PlainFallback>{props.children}</PlainFallback>}>
      <SyntaxHighlighter {...props} />
    </Suspense>
  );
}
