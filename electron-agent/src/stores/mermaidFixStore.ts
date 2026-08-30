import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MermaidFix {
  /** 修复后的 mermaid 源码（可成功渲染的版本）。 */
  code: string;
  /** true=由 AI（pi.fixMermaid）修复；false=本地 autoFixMermaid 启发式修复。徽章据此区分。 */
  ai: boolean;
}

interface MermaidFixState {
  /**
   * 原始 mermaid 源码 → 修复结果。pi 的会话是 append-only 树、无法原地改历史消息内容，
   * 故把修复结果按「原始 code」持久化到本地（localStorage: pi-mermaid-fixes）；切会话/重载后
   * Mermaid 组件据此用修复版渲染，不再重现崩坏。消息原文不变，不影响发给 LLM 的上下文。
   */
  fixes: Record<string, MermaidFix>;
  getFix: (raw: string) => MermaidFix | undefined;
  setFix: (raw: string, fixed: string, ai: boolean) => void;
}

export const useMermaidFixStore = create<MermaidFixState>()(
  persist(
    (set, get) => ({
      fixes: {},
      getFix: (raw) => get().fixes[raw],
      setFix: (raw, fixed, ai) =>
        set((s) => {
          const cur = s.fixes[raw];
          if (cur && cur.code === fixed && cur.ai === ai) return s;
          // AI 修复优先级高于本地启发式：已有 AI 修复时，不被随后的 auto 修复覆盖。
          if (cur?.ai && !ai) return s;
          return { fixes: { ...s.fixes, [raw]: { ai, code: fixed } } };
        }),
    }),
    { name: 'pi-mermaid-fixes' },
  ),
);
