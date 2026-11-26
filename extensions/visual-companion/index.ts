import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { detectMode } from "./autoMode.js";
import { resolveVisualFile } from "./resolveVisualFile.js";
import { publishVisualReview, restoreVisualReviews, visualReviewOwner } from "./reviewRegistry.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const owner = visualReviewOwner(ctx);
    if (!owner) return;
    const results = ctx.sessionManager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
        ? [entry.message as { toolName: string; details?: unknown }] : [],
    );
    restoreVisualReviews(owner, results);
  });

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
      "调用后立即返回唯一 previewId，页面只负责预览；点击其中的卡片只切换显示，不算回答或通过。" +
      "随后调用 ask_user 并传 visualReview.previewId，首题明确让用户通过或打回当前产出。" +
      "方案、参数与补充意见也放在 ask_user 的题目中；新题默认可填自定义答案，确需封闭才设 allowCustom=false。" +
      "打回或重新生成后必须 show_visual 发布新 previewId 并重新评审，取消、超时、旧预览与无界面答复绝不能视为通过。",
    ...toolPrompt("Show an existing HTML file or a short fragment in the UI.", [
      "Use show_visual with path when the page is already a file in the workspace; do not paste that file into html.",
      "Use show_visual html only for a short choice card that is not saved as a file.",
      "Use .split or .cards in show_visual for side-by-side options; they wrap when narrow and stretch in the visual panel. Do not lay options out in one nowrap flex row.",
      "Use show_visual only to preview; after each publication, call ask_user with visualReview.previewId and put approval, scheme, parameters and optional follow-up in its questions. Never infer approval from preview clicks.",
      "Use ask_user's open custom-answer default for new questions; an explicit allowCustom=false closes a question. A redo requires a new show_visual publication and a new ask_user review.",
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

      // Each publication has a non-reusable identity, distinct from renderer's remount revision.
      const review = publishVisualReview(visualReviewOwner(ctx));
      // 推给前端：复用 setStatus 管道，statusKey='visual'，statusText=JSON
      const payload = JSON.stringify({ action: "show", html, mode, previewId: review.previewId });
      ctx.ui.setStatus("visual", payload);

      // inline 模式：往对话流追加一条 visual-inline notice，content 里携带 HTML
      // 这样历史回放时 VisualCard 直接从消息读 html，不依赖 store
      if (mode === "inline") {
        pi.sendMessage(
          { customType: "visual-inline", content: html, display: true, details: { previewId: review.previewId } },
          { triggerTurn: false },
        );
      }

      return { content: [{ type: "text", text: `[visual shown, mode=${mode}, previewId=${review.previewId}] 请用 ask_user({visualReview:{previewId}}) 提交这版视觉评审。` }], details: { previewId: review.previewId, mode } };
    },
  });

  // ── read_visual_choice ───────────────────────────────────────
  pi.registerTool({
    name: "read_visual_choice",
    label: "Read Visual Choice",
    description: "旧视觉选择等待已迁移：立即返回 VISUAL_REVIEW_MIGRATED 错误，不再等待 iframe。请使用 ask_user.visualReview.previewId 评审具体产出。",
    ...toolPrompt("Legacy visual choice channel: returns a migration error immediately.", [
      "Do not use read_visual_choice; it always fails with VISUAL_REVIEW_MIGRATED. Use ask_user with the current show_visual previewId instead.",
    ]),
    parameters: Type.Object({
      timeout: Type.Optional(
        Type.Number({ description: "旧参数，仅供兼容；不会执行等待。", default: 300 }),
      ),
    }),
    async execute() {
      return {
        content: [{ type: "text", text: "VISUAL_REVIEW_MIGRATED: 旧页面确认已停用；调用 ask_user 并传入当前 show_visual 的 previewId。此结果不是通过。" }],
        details: { error: "VISUAL_REVIEW_MIGRATED" },
        isError: true,
      };
    },
  });
}
