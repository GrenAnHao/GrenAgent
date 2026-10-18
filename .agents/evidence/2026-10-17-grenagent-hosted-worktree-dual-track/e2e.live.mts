// 端到端：真实 IsolatedWorkspaceService 建 A 轨，真实 sandbox / safety 扩展 + 真实 Windows 沙箱（PiSandbox）跑 bash。
// 运行（仓库根）：pnpm exec tsx .agents/evidence/2026-10-17-grenagent-hosted-worktree-dual-track/e2e.live.mts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedWorkspaceService } from "../../../electron-agent/electron/app/isolatedWorkspaceService.js";
import { setApprovalPolicy } from "../../../extensions/_shared/approval.js";
import { isolatedWorkspaceOf } from "../../../extensions/_shared/isolated-workspace.js";
import sandbox from "../../../extensions/sandbox/index.js";
import safety from "../../../extensions/safety/index.js";
import { createWorktree } from "../../../extensions/working-directory/worktree.js";

const results: Array<[string, boolean, string?]> = [];
const check = (label: string, ok: boolean, detail?: string) => {
  results.push([label, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { encoding: "utf8" }).trim();

const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "gren-iso-e2e-")));
try {
  // 主仓：从一个 bare remote 克隆，本地再领先一个提交。
  const remote = join(tmp, "remote.git");
  const repo = join(tmp, "repo");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, repo);
  writeFileSync(join(repo, "a.txt"), "A\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "A");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  writeFileSync(join(repo, "local.txt"), "local\n");
  git(repo, "add", "local.txt");
  git(repo, "commit", "-q", "-m", "local");

  const marker = await new IsolatedWorkspaceService().create({ project: repo });
  const w = marker.path;
  console.log(`W = ${w}`);
  check("A 轨建在 <repo>/.gren/worktrees/<id>，.git 在 W 内", w.toLowerCase().startsWith(join(repo, ".gren", "worktrees").toLowerCase()) && existsSync(join(w, ".git", "HEAD")));
  check("默认 base = fresh（origin/main），不是本地 HEAD", marker.base.kind === "fresh" && marker.base.commit !== git(repo, "rev-parse", "HEAD"), `${marker.base.ref} ${marker.base.commit.slice(0, 8)}`);
  check("isolatedWorkspaceOf(W) 认得出", isolatedWorkspaceOf(w)?.id === marker.id);
  check("主仓 git status 干净", git(repo, "status", "--porcelain") === "");

  // ---- sandbox 扩展：full 档，以 W 为会话根 ----
  setApprovalPolicy("full", w);
  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> }> = [];
  const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
  sandbox({ registerTool: (t: never) => tools.push(t), on: (e: string, h: never) => (handlers[e] = h) } as never);
  const sessionManager = { getSessionId: () => "e2e-iso", getCwd: () => w, getSessionFile: () => undefined };
  await handlers.session_start?.({}, { cwd: w, sessionManager });
  const bash = tools.find((t) => t.name === "bash")!;
  const ctx = { cwd: w, hasUI: true, ui: { select: async () => "允许本次" }, sessionManager };
  const run = (command: string, extra: Record<string, unknown> = {}) =>
    bash.execute(`call-${Math.random()}`, { command, description: "e2e", ...extra }, undefined, undefined, ctx);
  const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

  const inside = await run("echo in > inside.txt && echo ok");
  check("沙箱 bash 能写 W", existsSync(join(w, "inside.txt")), text(inside).trim().slice(0, 80));

  const escape = await run("echo out > ../../../escape.txt; echo done");
  check("沙箱 bash 写不进主仓（full 档也被钳到 workspace-write）", !existsSync(join(repo, "escape.txt")), text(escape).replace(/\s+/g, " ").slice(0, 160));

  const commit = await run("git add inside.txt && git -c user.name=t -c user.email=t@example.com commit -q -m in-sandbox && git log --oneline -1");
  check("沙箱里 git commit 成功（.git 在 W 内）", git(w, "log", "-1", "--format=%s") === "in-sandbox", text(commit).trim().slice(0, 80));

  const push = await run("git push -q origin gren/" + marker.id + " 2>&1; echo exit=$?");
  // 注意：临时目录在用户目录下，PiSandbox 连主仓都读不到，这里 push 失败的原因是读不到 remote，不是单独证明「写 .git 被拒」。
  // 写主仓被 OS 拒由上面 escape.txt 那条证明。
  check("沙箱里 git push 回主仓没有生效（本例为读不到主仓）", !git(repo, "for-each-ref", "--format=%(refname)").includes(`gren/${marker.id}`), text(push).replace(/\s+/g, " ").slice(0, 160));

  let escalationError = "";
  try {
    await run("echo x > ../../../escalated.txt", { sandbox_permissions: "danger-full-access", justification: "试图写主仓" });
  } catch (e) {
    escalationError = String((e as Error).message);
  }
  check("升权 danger-full-access 被拒、不执行", /isolated workspace/.test(escalationError) && !existsSync(join(repo, "escalated.txt")), escalationError.slice(0, 120));

  // ---- safety 扩展：full 档写主仓 ----
  let toolCall: ((e: unknown, c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined;
  safety({ on: (e: string, h: never) => { if (e === "tool_call") toolCall = h; } } as never);
  const refused = await toolCall!({ toolName: "write", input: { path: "../../../README.md" } }, { ...ctx, sessionManager });
  check("safety：full 档 write 主仓被硬拒绝", refused?.block === true && /独立工作区不能写主仓/.test(refused.reason ?? ""), refused?.reason?.slice(0, 120));
  const escalateCall = await toolCall!(
    { toolName: "bash", input: { command: "x", sandbox_permissions: "danger-full-access", justification: "y" } },
    { ...ctx, sessionManager },
  );
  check("safety：danger-full-access 升权被硬拒绝", escalateCall?.block === true);

  // ---- B 轨在 A 轨里：可写根 = W，元数据在 W/.git ----
  const b = await createWorktree({ cwd: w, writableRoot: w, name: "b-track-inside" });
  check("A 轨里 create_worktree 可用，checkout 与元数据都在 W 内", b.path.toLowerCase().startsWith(w.toLowerCase()) && existsSync(join(w, ".git", "worktrees")), b.path);

  // ---- 宿主回传 ----
  const back = await new IsolatedWorkspaceService().syncBack(repo, marker.id);
  check("宿主 syncBack 把 W 分支快进到主仓", git(repo, "rev-parse", `refs/heads/${back.branch}`) === git(w, "rev-parse", "HEAD"), `${back.branch} ${back.commit.slice(0, 8)}`);
  // ---- P2：状态 → 删除 → 探测为已删除，主仓分支保留 ----
  const svc = new IsolatedWorkspaceService();
  const st = await svc.state(repo, marker.id);
  check("回传后状态是已回传（忽略 B 轨目录带来的未跟踪）", st.synced === true && st.ahead >= 1, JSON.stringify(st));
  const removed = await svc.remove(repo, marker.id, { force: st.dirty });
  check("删除独立工作区：目录和 marker 都没了", removed.removed && !existsSync(w) && !svc.list(repo).some((e) => e.id === marker.id));
  check("删除后探测为 missing（侧栏标「已删除」、会话只读）", svc.probe([w])[w] === "missing");
  check("主仓的 gren/<id> 分支保留", git(repo, "rev-parse", "--verify", `refs/heads/gren/${marker.id}`).length === 40);
  check("主仓 .git/info/exclude 有 /.gren/", readFileSync(join(repo, ".git", "info", "exclude"), "utf8").includes("/.gren/"));

  check("主仓工作树没被改（无 escape/escalated，local.txt 仍在）", !existsSync(join(repo, "escape.txt")) && readFileSync(join(repo, "local.txt"), "utf8") === "local\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
