// working-directory：每会话工作目录与显式 worktree（子代理重新设计阶段 2.5，照 DSH）。
//   working_directory({cd?})       读当前目录，或切到一个已存在的目录（也用来离开 worktree）。
//   create_worktree({name?, from?}) 从已提交的版本建新分支和 checkout，再把调用方自己的会话切过去。
// 委派本身不再隐含隔离。切换只改这一个会话的工作目录：权限根、审批、注册表仍按原始目录，
// 已经起来的进程、终端、MCP 服务器保留各自的目录。离开时 checkout 和分支都保留，不自动删、不自动合并。

import { getAgentDir, loadProjectContextFiles, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import { projectCwd, sameDirectory, sessionCwdController } from "../_shared/session-cwd.js";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { createWorktree } from "./worktree.js";

type Ctx = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

function sessionIdOf(ctx: Ctx): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

const UNAVAILABLE = "This session cannot change its working directory (no working-directory controller is attached).";

function isReadonlySession(): boolean {
  const flag = getConfig("SAFETY_READONLY");
  return flag === "1" || flag?.toLowerCase() === "true" || getApprovalPolicy() === "readonly";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "working_directory",
    label: "Working Directory",
    description:
      "Read the current working directory, or change it with cd. Relative paths use the current directory; the target must already exist. " +
      "Only this session moves: file tools and new shell commands follow it, while running processes, terminals and MCP servers keep their own directories, " +
      "and permissions stay tied to the original workspace. Use it to leave a worktree created by create_worktree.",
    ...toolPrompt("Read or change this session's working directory."),
    parameters: Type.Object({
      cd: Type.Optional(Type.String({ description: "Existing directory to enter. Omit to read the current directory." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const controller = sessionCwdController(sessionIdOf(ctx));
      if (!controller) return errorResult(UNAVAILABLE);
      const cd = typeof params.cd === "string" ? params.cd : undefined;
      if (cd === undefined) {
        const cwd = controller.current();
        return { content: [{ type: "text", text: cwd }], details: { cwd, original: controller.original() } };
      }
      try {
        const change = controller.set(cd);
        const text = change.changed
          ? `Working directory changed from "${change.previous}" to "${change.cwd}". Running processes, terminals and MCP servers keep their own directories.`
          : `Working directory unchanged: "${change.cwd}".`;
        return {
          content: [{ type: "text", text }],
          details: { cwd: change.cwd, previous: change.previous, changed: change.changed, original: controller.original() },
        };
      } catch (e) {
        return errorResult(String((e as Error)?.message ?? e));
      }
    },
  });

  pi.registerTool({
    name: "create_worktree",
    label: "Create Worktree",
    description:
      "Create a new Git branch and worktree from a local commit, branch, or tag, then change this session's working directory to it. " +
      "Defaults to HEAD and a generated name; the checkout goes under <repository>/.agents/worktrees/<name>. " +
      "Uncommitted files stay in the source checkout. Existing names fail. " +
      "Use working_directory with cd to leave; the checkout and branch remain. Existing MCP servers keep pointing at the original directory.",
    ...toolPrompt("Create a Git worktree and move this session into it.", [
      "Use create_worktree only when the user wants work isolated on its own branch or checkout; it never copies uncommitted changes, and leaving with working_directory keeps the checkout and branch.",
    ]),
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "New branch name, also used as the checkout directory. Omit to generate a unique name." }),
      ),
      from: Type.Optional(
        Type.String({ description: "Local commit, branch, or tag to start from. Defaults to HEAD; no fetch is performed." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const controller = sessionCwdController(sessionIdOf(ctx));
      if (!controller) return errorResult(UNAVAILABLE);
      if (isReadonlySession()) return errorResult("create_worktree is not available in a read-only session.");
      try {
        const created = await createWorktree({
          cwd: controller.current(),
          writableRoot: projectCwd(ctx),
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          ...(typeof params.from === "string" ? { from: params.from } : {}),
          ...(signal ? { signal } : {}),
        });
        const change = controller.set(created.path);
        const text =
          `${JSON.stringify(created)}\n` +
          `This session now works in "${change.cwd}" (was "${change.previous}"). ` +
          "Existing MCP servers, terminals and running processes still use the original directory.";
        return { content: [{ type: "text", text }], details: { ...created, previous: change.previous } };
      } catch (e) {
        return errorResult(String((e as Error)?.message ?? e));
      }
    },
  });

  // SDK 的资源加载器只认会话创建时的目录；切到别的目录后，项目说明（AGENTS.md）按当前目录重读，
  // 从下一次用户输入起以系统提示补丁的形式生效。skills / prompt 模板 / 项目设置仍按原始目录（SDK 限制）。
  pi.on("before_agent_start", (event, ctx) => {
    if (getConfig("PI_DISABLE_PROJECT_CONTEXT") === "1") return;
    if (sameDirectory(projectCwd(ctx), ctx.cwd)) return;
    try {
      event.systemPromptOptions.contextFiles = loadProjectContextFiles({ cwd: ctx.cwd, agentDir: getAgentDir() });
      event.systemPromptOptions.cwd = ctx.cwd;
    } catch {
      /* 读不到就保持原来的项目说明 */
    }
  });
}
