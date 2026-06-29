// checkpoint: snapshot the workspace each turn (git shadow repo) and allow
// reverting the working-tree files to any snapshot. Conversation is untouched.
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diff, ensureRepo, restore, track } from "./snapshot.js";
import { CheckpointStore } from "./store.js";

const ENABLED = (process.env.CHECKPOINT ?? "1") !== "0";

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;
  console.error("[checkpoint] extension loaded");
  let store: CheckpointStore | undefined;
  let gitdir = "";

  const ensure = (cwd: string): { store: CheckpointStore; gitdir: string } => {
    if (!store) {
      const base = join(cwd, ".pi", "snapshots");
      gitdir = join(base, "git");
      store = new CheckpointStore(join(base, "meta.db"));
      store.load();
    }
    return { store: store as CheckpointStore, gitdir };
  };

  const snapshot = async (
    cwd: string,
    label: string,
    kind: "auto" | "manual",
  ): Promise<{ id: string; files: number } | null> => {
    try {
      const { store, gitdir } = ensure(cwd);
      await ensureRepo(gitdir, cwd);
      const r = await track(gitdir, cwd);
      if (!r) return null;
      const { id } = store.add({ hash: r.hash, label, kind, files: JSON.stringify(r.files) });
      console.error(`[checkpoint] ${kind} snapshot ${id} (${r.files.length} file(s)) in ${cwd}`);
      return { id, files: r.files.length };
    } catch (e) {
      console.error(`[checkpoint] snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  let lastPrompt = "";
  let baselineDone = false;

  // Before the first turn: capture a baseline of the pre-change workspace so the
  // first turn is revertable. (Subsequent pre-change state == previous turn's end snapshot.)
  pi.on("before_agent_start", async (event, ctx) => {
    lastPrompt = typeof (event as { prompt?: unknown }).prompt === "string" ? (event as { prompt: string }).prompt.trim() : "";
    if (!baselineDone) {
      baselineDone = true;
      await snapshot(ctx.cwd, "初始状态 (baseline)", "auto").catch(() => {});
    }
    return undefined;
  });

  // After each turn: snapshot the changes the turn just made, so a checkpoint
  // reflecting that change appears immediately (track() skips no-op turns).
  pi.on("agent_end", async (_event, ctx) => {
    // 后台非阻塞：回合快照不该拖住 agent_end，否则 UI 会一直停在「运行中」直到快照落盘。回合结束到
    // 下一次 before_agent_start 之间工作区是稳定的，延后快照不影响正确性（best-effort）。
    void snapshot(ctx.cwd, lastPrompt.slice(0, 80) || "(turn)", "auto").catch(() => {});
  });

  pi.registerCommand("checkpoint", {
    description: "Checkpoints: /checkpoint list | create [label] | diff <id> | revert <id> | clear",
    handler: async (args, ctx) => {
      const { store, gitdir } = ensure(ctx.cwd);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "list";

      if (sub === "list") {
        const rows = store.list(50);
        const lines = rows.map((r) => {
          const n = (() => {
            try {
              return (JSON.parse(r.files) as unknown[]).length;
            } catch {
              return 0;
            }
          })();
          return `[${r.id}] (${r.kind}) ${r.label} — ${n} file(s)`;
        });
        ctx.ui.notify(lines.length ? `${lines.length} checkpoint(s):\n${lines.join("\n")}` : "No checkpoints.", "info");
        return;
      }

      if (sub === "create") {
        const label = parts.slice(1).join(" ").trim() || "manual checkpoint";
        const r = await snapshot(ctx.cwd, label, "manual");
        ctx.ui.notify(
          r ? `Checkpoint [${r.id}] saved (${r.files} file(s)).` : "No changes to snapshot.",
          r ? "success" : "info",
        );
        return;
      }

      if (sub === "diff") {
        const cp = store.getById(parts[1] ?? "");
        if (!cp) {
          ctx.ui.notify("Usage: /checkpoint diff <id>", "warning");
          return;
        }
        await ensureRepo(gitdir, ctx.cwd);
        const d = await diff(gitdir, ctx.cwd, cp.hash);
        ctx.ui.notify(d ? d.slice(0, 4000) : "No differences from this checkpoint.", "info");
        return;
      }

      if (sub === "revert") {
        const cp = store.getById(parts[1] ?? "");
        if (!cp) {
          ctx.ui.notify("Usage: /checkpoint revert <id>", "warning");
          return;
        }
        await ensureRepo(gitdir, ctx.cwd);
        await restore(gitdir, ctx.cwd, cp.hash);
        ctx.ui.notify(`Reverted working files to checkpoint [${cp.id}].`, "success");
        return;
      }

      if (sub === "clear") {
        store.clear();
        ctx.ui.notify("Cleared checkpoint metadata.", "info");
        return;
      }

      ctx.ui.notify("Usage: /checkpoint list | create [label] | diff <id> | revert <id> | clear", "warning");
    },
  });
}
