import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { detectMode } from "./autoMode.js";
import { resolveVisualFile } from "./resolveVisualFile.js";

export default function (pi: ExtensionAPI) {
  // ── show_visual ──────────────────────────────────────────────
  pi.registerTool({
    name: "show_visual",
    label: "Show Visual",
    description:
      "在 GrenAgent 界面展示 HTML 视觉内容（选项卡、原型、整页设计）。" +
      "已经写在工作区里的页面传 path，工具自己读文件，不要把文件内容再贴进 html。" +
      "html 只用于没有落盘的短选项卡。" +
      "mode='auto'（默认）：含 .mockup/.split/.cards 类 → 右侧「视觉设计」标签；其余 → 聊天流内联卡片。" +
      "多个方案放进 .split 或 .cards：窄了会折行，右侧面板会把比较区撑满高度。不要用单行不换行的 flex 把方案挤在一起。" +
      "调用后立即返回；用 read_visual_choice 阻塞，直到用户确认页面。\n" +
      "点选项只选中，也可以用来切换查看方案，不会提交。页面底部有「确认提交」；没有选项的页面设计则是「确定页面」。\n\n" +
      "【重要】生成选项 HTML 时必须使用 data-choice 属性（不是 data-value），例如：\n" +
      '<div class="option" data-choice="a" onclick="toggleSelect(this)">' +
      '<div class="letter">A</div><div class="content"><h3>选项标题</h3></div></div>',
    ...toolPrompt("Show an existing HTML file or a short fragment in the UI.", [
      "Use show_visual with path when the page is already a file in the workspace; do not paste that file into html.",
      "Use show_visual html only for a short choice card that is not saved as a file.",
      "Use .split or .cards in show_visual for side-by-side options; they wrap when narrow and stretch in the visual panel. Do not lay options out in one nowrap flex row.",
      "Use show_visual option clicks only to select or switch the visible scheme. The user confirms the page with the injected button; do not treat an option click as the final answer.",
    ]),
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "工作区内已生成的 .html 文件路径。整页预览优先用这个。" })),
      html: Type.Optional(Type.String({ description: "未落盘的短 HTML 片段。整页不要用这个参数重贴文件内容。" })),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("inline"), Type.Literal("panel"), Type.Literal("auto")],
          { description: "渲染位置，默认 auto" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let html = "";
      try {
        const filePath = typeof params.path === "string" ? params.path.trim() : "";
        if (filePath) {
          html = (await readFile(resolveVisualFile(ctx.cwd, filePath), "utf8")).trim();
        } else {
          html = (params.html ?? "").trim();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: undefined };
      }
      if (!html) {
        return { content: [{ type: "text", text: "show_visual: 需要 path 或 html。" }], details: undefined };
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
      "阻塞等待用户在视觉设计里确认页面。点选项不会返回；用户点「确认提交」或「确定页面」后才返回。必须在 show_visual 之后调用。",
    promptSnippet: "Wait until the user confirms the visual page after show_visual.",
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
