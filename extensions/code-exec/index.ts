// code-exec：常驻 Python 执行内核。
//
// 注册 py_run（在常驻进程里执行代码，变量/导入跨调用保留）与 py_reset（清空命名空间）。
// 内核按 ctx.cwd 隔离（多会话/子代理互不串），随 session_shutdown / 扩展卸载清理子进程。
// 定位：有状态的"计算 cell"；一次性命令仍走 bash。py_run 是执行类工具，不入只读白名单，
// 故 Ask/Plan 模式下被 agent-mode 隐藏并拦截。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { JsKernel } from "./js-kernel.js";
import { type PythonInfo, PythonKernel, detectPython } from "./kernel.js";
import { formatResult } from "./protocol.js";

const RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "runner.py");
const JS_RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "runner.mjs");

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  console.error("[code-exec] extension loaded");

  const kernels = new Map<string, PythonKernel>();
  // undefined=未探测；null=探测过且不可用；PythonInfo=可用解释器。
  let python: PythonInfo | null | undefined;

  const resolvePython = (): PythonInfo | null => {
    if (python === undefined) python = detectPython(getConfig("PI_PYTHON")) ?? null;
    return python;
  };

  const kernelFor = (cwd: string, info: PythonInfo): PythonKernel => {
    let k = kernels.get(cwd);
    if (!k) {
      k = new PythonKernel(info, RUNNER_PATH, cwd);
      kernels.set(cwd, k);
    }
    return k;
  };

  pi.registerTool({
    name: "py_run",
    label: "Python",
    description:
      "在常驻 Python 内核中执行代码，变量与已导入模块跨调用保留——适合多步数据分析/计算。" +
      "返回 stdout、最后一个表达式的值（=> 回显）与异常 traceback。" +
      "一次性 shell 命令请用 bash；需要清空状态用 py_reset。",
    promptSnippet: "Execute Python in a persistent kernel.",
    parameters: Type.Object({
      code: Type.String({ description: "要执行的 Python 代码（可多行）" }),
      timeout_ms: Type.Optional(Type.Number({ description: "执行超时（毫秒），默认 30000" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const info = resolvePython();
      if (!info) {
        return textResult("未找到 Python（已尝试 py -3 / python3 / python）。请安装 Python，或用 PI_PYTHON 指定解释器路径。");
      }
      const kernel = kernelFor(ctx.cwd, info);
      try {
        const result = await kernel.exec(params.code ?? "", {
          timeoutMs: params.timeout_ms,
          signal: signal ?? undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], details: { ok: result.ok } };
      } catch (err) {
        return textResult(`执行失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "py_reset",
    label: "Python Reset",
    description: "重置常驻 Python 内核：清空所有变量与已导入模块，下次 py_run 从干净命名空间开始。",
    promptSnippet: "Reset the persistent Python kernel.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const kernel = kernels.get(ctx.cwd);
      if (!kernel) return textResult("内核尚未启动，无需重置。");
      try {
        await kernel.reset();
        return textResult("Python 内核已重置（变量与导入已清空）。");
      } catch (err) {
        return textResult(`重置失败：${(err as Error).message}`);
      }
    },
  });

  const jsKernels = new Map<string, JsKernel>();
  const jsKernelFor = (cwd: string): JsKernel => {
    let k = jsKernels.get(cwd);
    if (!k) {
      k = new JsKernel(JS_RUNNER_PATH, cwd);
      jsKernels.set(cwd, k);
    }
    return k;
  };

  pi.registerTool({
    name: "js_run",
    label: "JavaScript",
    description:
      "在常驻 Node(vm) 内核执行 JS，变量跨调用保留——适合多步计算/数据处理。" +
      "跨 cell 持久请用 var 或全局赋值（x = 1）；顶层 let/const 块级不跨 cell。" +
      "返回 console 输出与末尾表达式的值（=> 回显）。需 await 请用 .then（top-level await 暂不支持）；需清空状态用 js_reset。",
    promptSnippet: "Execute JavaScript in a persistent kernel.",
    parameters: Type.Object({
      code: Type.String({ description: "要执行的 JS 代码（可多行）" }),
      timeout_ms: Type.Optional(Type.Number({ description: "执行超时（毫秒），默认 30000" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const kernel = jsKernelFor(ctx.cwd);
      try {
        const result = await kernel.exec(params.code ?? "", {
          timeoutMs: params.timeout_ms,
          signal: signal ?? undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], details: { ok: result.ok } };
      } catch (err) {
        return textResult(`执行失败：${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "js_reset",
    label: "JavaScript Reset",
    description: "重置常驻 JS 内核：清空所有变量，下次 js_run 从干净上下文开始。",
    promptSnippet: "Reset the persistent JavaScript kernel.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const kernel = jsKernels.get(ctx.cwd);
      if (!kernel) return textResult("JS 内核尚未启动，无需重置。");
      try {
        await kernel.reset();
        return textResult("JS 内核已重置（变量已清空）。");
      } catch (err) {
        return textResult(`重置失败：${(err as Error).message}`);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    for (const kernel of kernels.values()) kernel.dispose();
    for (const kernel of jsKernels.values()) kernel.dispose();
    kernels.clear();
    jsKernels.clear();
  });
}
