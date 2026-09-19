import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectMode } from "./autoMode.js";

export default function (pi: ExtensionAPI) {
  // ── show_visual ──────────────────────────────────────────────
  pi.registerTool({
    name: "show_visual",
    label: "Show Visual",
    description:
      "在 GrenAgent 界面展示 HTML 视觉内容（选项卡、原型、架构图等）。" +
      "mode='auto'（默认）：含 .mockup/.split/.cards 类 → 右侧面板；其余 → 聊天流内联卡片。" +
      "调用后立即返回；用 read_visual_choice 阻塞等待用户选择。\n\n" +
      "【重要】生成选项 HTML 时必须使用 data-choice 属性（不是 data-value），例如：\n" +
      '<div class="option" data-choice="a" onclick="toggleSelect(this)">' +
      '<div class="letter">A</div><div class="content"><h3>选项标题</h3></div></div>',
    promptSnippet: "Show HTML visual content in the UI.",
    parameters: Type.Object({
      html: Type.String({ description: "HTML 片段或完整文档（支持 frame-template CSS 类）" }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("inline"), Type.Literal("panel"), Type.Literal("auto")],
          { description: "渲染位置，默认 auto" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const html = (params.html ?? "").trim();
      if (!html) {
        return { content: [{ type: "text", text: "show_visual: html 不能为空。" }], details: undefined };
      }
      const mode =
        params.mode === "inline" || params.mode === "panel"
          ? params.mode
          : detectMode(html);

      // 推给前端：复用 setStatus 管道，statusKey='visual'，statusText=JSON
      const payload = JSON.stringify({ action: "show", html, mode });
      ctx.ui.setStatus("visual", payload);

      // inline 模式：往对话流追加一条 visual-inline notice，content 里携带 HTML
      // 这样历史回放时 VisualCard 直接从消息读 html，不依赖 store
      if (mode === "inline") {
        pi.sendMessage(
          { customType: "visual-inline", content: html, display: true },
          { triggerTurn: false },
        );
      }

      return { content: [{ type: "text", text: `[visual shown, mode=${mode}]` }], details: undefined };
    },
  });

  // ── read_visual_choice ───────────────────────────────────────
  pi.registerTool({
    name: "read_visual_choice",
    label: "Read Visual Choice",
    description:
      "阻塞等待用户在视觉伴侣中点击选项，返回选择结果。必须在 show_visual 之后调用。",
    promptSnippet: "Wait for the user's visual choice after show_visual.",
    parameters: Type.Object({
      timeout: Type.Optional(
        Type.Number({ description: "超时秒数（默认 300）", default: 300 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const timeout = (params.timeout ?? 300) * 1000;

      // 复用 ctx.ui.input 作为阻塞信道（ask_user 也在用同一管道）
      // 前端识别 __visualChoice 哨兵后标记 pending；用户点击后 respondUi 回传 choice resolve
      const sentinel = JSON.stringify({ __visualChoice: 1 });
      const raw = await Promise.race([
        ctx.ui.input(sentinel, undefined, { signal }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("read_visual_choice timeout")), timeout),
        ),
      ]);

      if (typeof raw === "string") {
        return { content: [{ type: "text", text: raw }], details: undefined };
      }
      return {
        content: [{ type: "text", text: '{"error":"no choice received"}' }],
        details: undefined,
      };
    },
  });
}
