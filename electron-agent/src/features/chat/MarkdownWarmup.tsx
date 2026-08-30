import { useEffect, useState, type CSSProperties } from 'react';
import { LazyMarkdown } from './LazyMarkdown';

// 预热样本：覆盖正文 + 行内代码 + GFM 表格 + 围栏代码块（触发 shiki 高亮器：WASM + 主题 + grammar）
// + 行内数学（触发 katex）。一次离屏渲染即可把重型 markdown 渲染栈一次性初始化好。
const WARMUP_MD = [
  '# warm',
  '',
  'plain text with `inline code`',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x: number = 1;',
  '```',
  '',
  '$E = mc^2$',
  '',
].join('\n');

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
 * 后台预热重型 markdown 渲染栈：首启后空闲时离屏渲染一次含表格 / 围栏代码 / 数学的 markdown，
 * 把 @lobehub/ui Markdown 内部的 shiki 高亮器（oniguruma WASM + 主题 + grammar）、katex 等
 * 一次性加载初始化好。这样用户「首启后打开第一个对话」不再为这套首次异步初始化付几十秒等待——
 * 成本被挪到空闲时段。shiki / katex 初始化后由各自模块单例缓存，预热元素保持挂载（1px 隐藏、
 * 静态、memo 不重渲）即可让其常驻生效。
 */
export function MarkdownWarmup() {
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

  if (!warm) return null;

  return (
    <div aria-hidden style={HIDDEN_STYLE}>
      <LazyMarkdown variant="chat" fontSize={14}>
        {WARMUP_MD}
      </LazyMarkdown>
    </div>
  );
}
