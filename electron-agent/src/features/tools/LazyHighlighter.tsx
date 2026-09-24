import { useEffect, useState, type ComponentProps, type CSSProperties } from 'react';
import type { CodeDiff, Highlighter, SyntaxHighlighter } from '@lobehub/ui';

type LobeUi = typeof import('@lobehub/ui');

let cached: LobeUi | null = null;
const lobeUiReady: Promise<LobeUi> = import('@lobehub/ui').then((mod) => {
  cached = mod;
  return mod;
});

type HighlighterProps = ComponentProps<typeof Highlighter>;
type SyntaxHighlighterProps = ComponentProps<typeof SyntaxHighlighter>;
type CodeDiffProps = ComponentProps<typeof CodeDiff>;

function useLobeUi(): LobeUi | null {
  const [ui, setUi] = useState<LobeUi | null>(cached);
  useEffect(() => {
    if (ui) return;
    let alive = true;
    lobeUiReady.then((mod) => {
      if (alive) setUi(mod);
    });
    return () => {
      alive = false;
    };
  }, [ui]);
  return ui;
}

export function LazyHighlighter(props: HighlighterProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.Highlighter {...props} />;
}

export function LazySyntaxHighlighter(props: SyntaxHighlighterProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.SyntaxHighlighter {...props} />;
}

export function LazyCodeDiff(props: CodeDiffProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.CodeDiff {...props} />;
}

const HIDDEN_STYLE: CSSProperties = {
  position: 'fixed',
  insetBlockEnd: 0,
  insetInlineStart: 0,
  width: 1,
  height: 1,
  overflow: 'hidden',
  opacity: 0,
  pointerEvents: 'none',
  contain: 'strict',
  zIndex: -1,
};

/**
 * 启动时离屏挂一次高亮和 diff，把 @lobehub/ui 的样式、shiki 和 pierre 主题在用户展开卡片前注入。
 * 这些样式是首次挂载才写入文档的；不预热时，会话里第一张写入 / 编辑 / 检索 / 读取卡片会先闪一版无样式。
 */
export function CodeViewWarmup() {
  const ui = useLobeUi();
  if (!ui) return null;
  return (
    <div aria-hidden style={HIDDEN_STYLE}>
      <ui.Highlighter fileName="warmup.ts" language="ts" variant="outlined">
        {'const x = 1;\n'}
      </ui.Highlighter>
      <ui.CodeDiff
        fileName="warmup.ts"
        fullFeatured={false}
        language="ts"
        newContent={'const x = 1;\n'}
        oldContent={'const x = 0;\n'}
        showHeader={false}
        variant="outlined"
        viewMode="unified"
      />
    </div>
  );
}
