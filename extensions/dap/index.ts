// dap：通过 Debug Adapter Protocol 驱动真实调试器（一期 Python/debugpy）。
//
// 暴露 launch/setBreakpoints/continue/step/stackTrace/scopes/variables/evaluate/terminate。
// 控制类操作会等下一个 stopped/terminated 事件再返回。dap_* 是执行/控制语义，不入只读白名单
// （Ask/Plan 自动隐藏），受 safety/项目信任约束。与 debug-tools 互补：日志看趋势，DAP 断点精查。
// attach、Go(dlv)/native(lldb-dap)、前端调试面板列二期。
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AdapterSpec, detectPythonAdapter } from "./adapters.js";
import { DapClient, type StopResult } from "./client.js";

function formatStop(r: StopResult): string {
  if (r.terminated) return "程序已结束（terminated）。";
  if (r.reason === "timeout") return "（等待停驻超时；程序可能仍在运行或等待输入）";
  return `已停驻：reason=${r.reason ?? "?"}，thread=${r.threadId ?? "?"}。用 dap_stack_trace 查看调用栈。`;
}

function formatStack(body: unknown): string {
  const frames = (body as { stackFrames?: Array<Record<string, unknown>> })?.stackFrames ?? [];
  if (frames.length === 0) return "（无栈帧）";
  return frames
    .map((f) => {
      const src = (f.source as { path?: string } | undefined)?.path ?? "?";
      return `#${f.id} ${f.name} @ ${src}:${f.line}`;
    })
    .join("\n");
}

function formatVariables(body: unknown): string {
  const vars = (body as { variables?: Array<Record<string, unknown>> })?.variables ?? [];
  if (vars.length === 0) return "（无变量）";
  return vars
    .map((v) => {
      const ref = typeof v.variablesReference === "number" && v.variablesReference > 0 ? ` (ref=${v.variablesReference})` : "";
      return `${v.name}: ${v.value}${v.type ? ` [${v.type}]` : ""}${ref}`;
    })
    .join("\n");
}

function formatScopes(body: unknown): string {
  const scopes = (body as { scopes?: Array<Record<string, unknown>> })?.scopes ?? [];
  if (scopes.length === 0) return "（无作用域）";
  return scopes.map((s) => `${s.name} (ref=${s.variablesReference})`).join("\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  console.error("[dap] extension loaded");

  const sessions = new Map<string, DapClient>();
  let adapter: AdapterSpec | null | undefined;

  const resolveAdapter = (): AdapterSpec | null => {
    if (adapter === undefined) adapter = detectPythonAdapter() ?? null;
    return adapter;
  };

  const sessionFor = (cwd: string): DapClient | undefined => sessions.get(cwd);

  pi.registerTool({
    name: "dap_launch",
    label: "Debug Launch",
    description:
      "启动调试会话（一期 Python/debugpy）：运行 program 并进入可断点调试。" +
      "stopOnEntry=true 在首行暂停。随后用 dap_set_breakpoints/continue/step/stack_trace/variables/evaluate 排查。",
    promptSnippet: "Launch a Python debug session.",
    parameters: Type.Object({
      program: Type.String({ description: "要调试的脚本路径（相对工作区或绝对）" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "程序参数" })),
      stopOnEntry: Type.Optional(Type.Boolean({ description: "是否在入口暂停，默认 false" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const spec = resolveAdapter();
      if (!spec) {
        return textResult("未找到 Python 调试适配器。请先 `pip install debugpy`（一期仅支持 Python）。");
      }
      const existing = sessions.get(ctx.cwd);
      if (existing) existing.dispose();
      const program = isAbsolute(params.program ?? "") ? params.program : resolve(ctx.cwd, params.program ?? "");
      const client = new DapClient(spec, ctx.cwd);
      sessions.set(ctx.cwd, client);
      try {
        const r = await client.launch(program, params.args ?? [], params.stopOnEntry ?? false);
        const out = client.drainOutput();
        return textResult(`${formatStop(r)}${out ? `\n--- 输出 ---\n${out}` : ""}`);
      } catch (err) {
        return textResult(`启动失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "dap_set_breakpoints",
    label: "Debug Breakpoints",
    description: "为某文件设置断点（替换该文件已有断点）。",
    promptSnippet: "Set breakpoints in a debug session file.",
    parameters: Type.Object({
      path: Type.String({ description: "源文件路径" }),
      lines: Type.Array(Type.Number(), { description: "断点行号（1-based）" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = sessionFor(ctx.cwd);
      if (!client) return textResult("无调试会话，请先 dap_launch。");
      const path = isAbsolute(params.path ?? "") ? params.path : resolve(ctx.cwd, params.path ?? "");
      try {
        await client.setBreakpoints(path, params.lines ?? []);
        return textResult(`已设置 ${(params.lines ?? []).length} 个断点：${params.path}`);
      } catch (err) {
        return textResult(`设置断点失败：${(err as Error).message}`);
      }
    },
  });

  const control = (name: string, label: string, description: string, run: (c: DapClient) => Promise<StopResult>) =>
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: description,
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const client = sessionFor(ctx.cwd);
        if (!client) return textResult("无调试会话，请先 dap_launch。");
        try {
          const r = await run(client);
          const out = client.drainOutput();
          return textResult(`${formatStop(r)}${out ? `\n--- 输出 ---\n${out}` : ""}`);
        } catch (err) {
          return textResult(`操作失败：${(err as Error).message}`);
        }
      },
    });

  control("dap_continue", "Debug Continue", "继续执行到下一个断点/结束。", (c) => c.continue());
  control("dap_step_over", "Debug Step Over", "单步跳过（next）。", (c) => c.step("over"));
  control("dap_step_into", "Debug Step Into", "单步进入（stepIn）。", (c) => c.step("into"));
  control("dap_step_out", "Debug Step Out", "单步跳出（stepOut）。", (c) => c.step("out"));

  pi.registerTool({
    name: "dap_stack_trace",
    label: "Debug Stack",
    description: "查看当前停驻线程的调用栈（含 frameId，用于 scopes/evaluate）。",
    promptSnippet: "Get the current debug stack trace.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const client = sessionFor(ctx.cwd);
      if (!client) return textResult("无调试会话，请先 dap_launch。");
      try {
        return textResult(formatStack(await client.stackTrace()));
      } catch (err) {
        return textResult(`获取调用栈失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "dap_scopes",
    label: "Debug Scopes",
    description: "列出某栈帧的作用域（含 variablesReference，用于 dap_variables）。",
    promptSnippet: "List scopes for a debug stack frame.",
    parameters: Type.Object({ frameId: Type.Number({ description: "栈帧 id（来自 dap_stack_trace）" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = sessionFor(ctx.cwd);
      if (!client) return textResult("无调试会话，请先 dap_launch。");
      try {
        return textResult(formatScopes(await client.scopes(params.frameId ?? 0)));
      } catch (err) {
        return textResult(`获取作用域失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "dap_variables",
    label: "Debug Variables",
    description: "展开某 variablesReference 下的变量（来自 dap_scopes/dap_variables）。",
    promptSnippet: "Read variables from a debug scope.",
    parameters: Type.Object({
      variablesReference: Type.Number({ description: "变量引用句柄" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = sessionFor(ctx.cwd);
      if (!client) return textResult("无调试会话，请先 dap_launch。");
      try {
        return textResult(formatVariables(await client.variables(params.variablesReference ?? 0)));
      } catch (err) {
        return textResult(`获取变量失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "dap_evaluate",
    label: "Debug Evaluate",
    description: "在当前停驻上下文求值表达式（可指定 frameId）。",
    promptSnippet: "Evaluate an expression in the debug session.",
    parameters: Type.Object({
      expression: Type.String({ description: "要求值的表达式" }),
      frameId: Type.Optional(Type.Number({ description: "栈帧 id（默认顶帧上下文）" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = sessionFor(ctx.cwd);
      if (!client) return textResult("无调试会话，请先 dap_launch。");
      try {
        const body = (await client.evaluate(params.expression ?? "", params.frameId)) as {
          result?: string;
          type?: string;
        };
        return textResult(`${body?.result ?? "(无返回)"}${body?.type ? ` [${body.type}]` : ""}`);
      } catch (err) {
        return textResult(`求值失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "dap_terminate",
    label: "Debug Terminate",
    description: "结束当前调试会话并清理被调试进程。",
    promptSnippet: "Terminate the current debug session.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const client = sessionFor(ctx.cwd);
      if (!client) return textResult("无调试会话。");
      await client.terminate();
      sessions.delete(ctx.cwd);
      return textResult("调试会话已结束。");
    },
  });

  pi.on("session_shutdown", async () => {
    for (const c of sessions.values()) c.dispose();
    sessions.clear();
  });
}
