// hashline：按内容哈希(#TAG)锚定的行级编辑工具。
//
// hl_read 输出 [path#TAG] + 行号视图作为编辑锚点；hl_edit 解析补丁、用「实时磁盘内容」算 tag
// 校验新鲜度（过期即拒绝），再按原始行号应用 SWAP/DEL/INS。完整语法放在 hl_edit 的
// description（模型必看），避免与 agent-mode 的 before_agent_start 注入相互覆盖。
//
// MVP 与内置 read/edit 并存（靠 description 强引导），不隐藏内置——"接管"需与 agent-mode 的
// setActiveTools 整合，列为二期。.BLK 块操作（tree-sitter）亦为二期。
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchProtectedPath } from "../_shared/protected-paths.js";
import { applyOps } from "./apply.js";
import { parsePatch } from "./parser.js";
import { HASHLINE_PROMPT } from "./prompt.js";
import { recover } from "./recovery.js";
import { SnapshotStore } from "./snapshot-store.js";
import { computeTag, renderRead } from "./snapshots.js";

export default function (pi: ExtensionAPI) {
  console.error("[hashline] extension loaded");

  // hl_read 快照（内存，进程级，LRU 上限 50）：path → 模型读到的内容 + 当时 tag。供 hl_edit 锚点过期时 3-way merge 恢复。
  const snapshots = new SnapshotStore();

  pi.registerTool({
    name: "hl_read",
    label: "Read (hashline)",
    description:
      "读取文件并返回带 #TAG 内容快照与行号的视图（[path#TAG] 头 + `N:TEXT` 行），" +
      "作为 hl_edit 的编辑锚点。编辑已存在文件前先用它拿到当前 #TAG。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径（相对工作区或绝对）" }),
      offset: Type.Optional(Type.Number({ description: "起始行（1-based），默认 1" })),
      limit: Type.Optional(Type.Number({ description: "读取行数，默认全文" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rel = params.path ?? "";
      const abs = isAbsolute(rel) ? rel : resolve(ctx.cwd, rel);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch (err) {
        return { content: [{ type: "text", text: `读取失败：${(err as Error).message}` }] };
      }
      snapshots.set(abs, { content, tag: computeTag(abs, content) });
      const text = renderRead(rel, abs, content, { offset: params.offset, limit: params.limit });
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "hl_edit",
    label: "Edit (hashline)",
    description: HASHLINE_PROMPT,
    parameters: Type.Object({
      patch: Type.String({ description: "hashline 补丁文本（可含多个 [PATH#TAG] 段）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = parsePatch(params.patch ?? "");
      if (parsed.error) {
        return { content: [{ type: "text", text: `补丁解析失败：${parsed.error}` }] };
      }
      const applied: string[] = [];
      const rejected: string[] = [];
      for (const section of parsed.sections) {
        const abs = isAbsolute(section.path) ? section.path : resolve(ctx.cwd, section.path);
        // hl_edit 直接 writeFileSync，不经 safety 的 write/edit 保护路径闸；故此处自检，
        // 否则 .env/.git/keys 可借补丁内嵌路径绕过保护（safety ⑤ 只认 write/edit 工具名）。
        if (matchProtectedPath(section.path) || matchProtectedPath(abs)) {
          rejected.push(`${section.path}: 受保护路径，已拒绝写入（.env/.git/node_modules/*.pem/*.key）`);
          continue;
        }
        let content: string;
        try {
          content = readFileSync(abs, "utf8");
        } catch (err) {
          rejected.push(`${section.path}: 读取失败 ${(err as Error).message}`);
          continue;
        }
        const curTag = computeTag(abs, content);
        if (curTag !== section.tag) {
          const snap = snapshots.get(abs);
          if (snap && snap.tag === section.tag) {
            const rec = recover(snap.content, content, section.ops);
            if (rec.content !== undefined) {
              try {
                writeFileSync(abs, rec.content, "utf8");
              } catch (err) {
                rejected.push(`${section.path}: 写入失败 ${(err as Error).message}`);
                continue;
              }
              const newTag = computeTag(abs, rec.content);
              snapshots.set(abs, { content: rec.content, tag: newTag });
              applied.push(`${section.path}#${newTag}（#TAG 过期，已基于 hl_read 快照自动恢复，文件已变请核对）`);
              continue;
            }
            rejected.push(`${section.path}: #TAG 过期且自动恢复失败（${rec.error}），请重新 hl_read`);
            continue;
          }
          rejected.push(
            `${section.path}: #TAG 已过期（补丁 ${section.tag} ≠ 当前 ${curTag}）且无可用快照，请重新 hl_read`,
          );
          continue;
        }
        const result = applyOps(content, section.ops);
        if (result.error || result.content === undefined) {
          rejected.push(`${section.path}: ${result.error ?? "应用失败"}`);
          continue;
        }
        try {
          writeFileSync(abs, result.content, "utf8");
        } catch (err) {
          rejected.push(`${section.path}: 写入失败 ${(err as Error).message}`);
          continue;
        }
        const appliedTag = computeTag(abs, result.content);
        snapshots.set(abs, { content: result.content, tag: appliedTag });
        applied.push(`${section.path}#${appliedTag}`);
      }
      const parts: string[] = [];
      if (applied.length > 0) parts.push(`已应用（新 #TAG）：${applied.join(", ")}`);
      if (rejected.length > 0) parts.push(`被拒绝：\n- ${rejected.join("\n- ")}`);
      return {
        content: [{ type: "text", text: parts.join("\n") || "无改动" }],
        details: { applied, rejected },
      };
    },
  });
}
