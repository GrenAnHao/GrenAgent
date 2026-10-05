import { useEffect, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import type { CodeDiff, Highlighter, PatchDiff, SyntaxHighlighter } from '@lobehub/ui';

type LobeUi = typeof import('../../lib/lobeHeavy');

let cached: LobeUi | null = null;
let pending: Promise<LobeUi> | null = null;

/** 第一次有组件要用时才加载。放在模块顶层会和首屏抢解析、执行。 */
function loadLobeUi(): Promise<LobeUi> {
  pending ??= import('../../lib/lobeHeavy').then((mod) => {
    cached = mod;
    return mod;
  });
  return pending;
}

type HighlighterProps = ComponentProps<typeof Highlighter>;
type SyntaxHighlighterProps = ComponentProps<typeof SyntaxHighlighter>;
type CodeDiffProps = ComponentProps<typeof CodeDiff>;
type PatchDiffProps = ComponentProps<typeof PatchDiff>;

function useLobeUi(): LobeUi | null {
  const [ui, setUi] = useState<LobeUi | null>(cached);
  useEffect(() => {
    if (ui) return;
    let alive = true;
    void loadLobeUi().then((mod) => {
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

export function LazySyntaxHighlighter({
  fallback = null,
  ...props
}: SyntaxHighlighterProps & { fallback?: ReactNode }) {
  const ui = useLobeUi();
  if (!ui) return <>{fallback}</>;
  return <ui.SyntaxHighlighter {...props} />;
}

export function LazyCodeDiff(props: CodeDiffProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.CodeDiff {...props} />;
}

/** 和 LazyCodeDiff 同一套渲染（@pierre/diffs），吃单文件 unified patch，保留真实行号与 hunk 分隔。 */
export function LazyPatchDiff(props: PatchDiffProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.PatchDiff {...props} />;
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
 * 启动后离屏挂一次高亮和 diff，把 @lobehub/ui 的样式、shiki 和 pierre 主题在用户展开卡片前注入。
 * 这些样式是首次挂载才写入文档的；不预热时，会话里第一张写入 / 编辑 / 检索 / 读取卡片会先闪一版无样式。
 * 和 MarkdownWarmup 一样等浏览器空闲（最多 3s）再开始，不挤首屏。
 */
export function CodeViewWarmup() {
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    const ric = typeof window !== 'undefined' ? window.requestIdleCallback : undefined;
    if (ric) {
      const handle = ric(() => setWarm(true), { timeout: 3000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(() => setWarm(true), 1500);
    return () => window.clearTimeout(handle);
  }, []);
  return warm ? <CodeViewWarmupBody /> : null;
}

function CodeViewWarmupBody() {
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
      <ui.SyntaxHighlighter animated language="typescript" variant="borderless">
        {'const x = 1;\n'}
      </ui.SyntaxHighlighter>
    </div>
  );
}
