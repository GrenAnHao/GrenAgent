// debug-tools: runtime debugging by code instrumentation, inspired by Cursor Debug Mode.
//
// 提供一个 `debug_log` 工具 + 一个本地 HTTP 日志收集器，支撑「调查先于动手」闭环：
//   start     → 起收集器（127.0.0.1 随机端口）+ 截断 .pi/debug/debug.log，返回 endpoint 与插桩指南
//   instrument→ 按语言给出把 {tag,data} POST 到 endpoint 的插桩片段
//   read      → 读回已收集的运行时数据（变量值/执行路径/时序），用于定位根因
//   status    → 收集器状态与已收条数
//   clear     → 清空本轮日志（内存 + 文件）
//   stop      → 关收集器，并提醒移除插桩
//
// 仅监听回环地址；日志同时落盘到 <cwd>/.pi/debug/debug.log，便于 read/grep 复查。
// ask 模式不在白名单内（写文件 + 起 server），自动被 agent-mode 拦截；debug/agent 模式可用。

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { instrumentGuide, instrumentSnippet, normalizeLang } from "./instrument.js";
import { LogStore } from "./logstore.js";
import { LogServer } from "./server.js";

const DebugLogParams = Type.Object({
  action: StringEnum(["start", "instrument", "read", "status", "clear", "stop"] as const),
  lang: Type.Optional(
    Type.String({ description: "For instrument: js/ts/python/shell/go/rust/java/ruby/php" }),
  ),
  limit: Type.Optional(Type.Number({ description: "For read: only the last N entries" })),
});

export default function (pi: ExtensionAPI) {
  console.error("[debug-tools] extension loaded");

  const store = new LogStore();
  const server = new LogServer();
  let logFile: string | undefined;

  const endpointFor = (port: number) => `http://127.0.0.1:${port}/log`;

  const ensureLogFile = (cwd: string): string => {
    const dir = join(cwd, ".pi", "debug");
    mkdirSync(dir, { recursive: true });
    return join(dir, "debug.log");
  };

  const appendToFile = (line: string) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* 落盘是 best-effort：磁盘满/权限问题不应影响内存收集 */
    }
  };

  const truncateFile = () => {
    if (!logFile) return;
    try {
      writeFileSync(logFile, "");
    } catch {
      /* ignore */
    }
  };

  pi.registerTool({
    name: "debug_log",
    label: "Debug Log",
    description:
      "Runtime debugging via code instrumentation. Start a local log collector, " +
      "instrument code to POST diagnostics (variable values, execution paths, timing), have the user reproduce " +
      "the bug, then read back the captured runtime data to pinpoint the root cause and make a minimal fix. " +
      "Actions: start | instrument | read | status | clear | stop.",
    promptGuidelines: [
      "In Debug mode prefer evidence over guessing: debug_log(start) → instrument hypotheses → user reproduces → debug_log(read) → minimal fix → remove instrumentation → debug_log(stop).",
    ],
    parameters: DebugLogParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === "start") {
        const port = await server.start({
          onLog: (entry) => appendToFile(JSON.stringify(store.push(entry))),
        });
        logFile = ensureLogFile(ctx.cwd);
        // 开新一轮：清内存计数 + 截断文件。
        store.clear();
        truncateFile();
        const endpoint = endpointFor(port);
        return {
          content: [
            {
              type: "text" as const,
              text: `Debug log collector started.\nendpoint: ${endpoint}\nlog file: ${logFile}\n\n${instrumentGuide(endpoint, logFile)}`,
            },
          ],
          details: { port, endpoint, logFile },
        };
      }

      if (action === "instrument") {
        if (!server.running || server.port === undefined) {
          return {
            content: [{ type: "text" as const, text: 'Collector not running. Call debug_log(action:"start") first.' }],
            details: { error: "not-started" },
          };
        }
        const lang = normalizeLang(params.lang);
        const endpoint = endpointFor(server.port);
        const snippet = instrumentSnippet(lang, endpoint);
        return {
          content: [
            {
              type: "text" as const,
              text: `Instrumentation snippet (${lang}). Replace TAG with a hypothesis label and fill data with the variables to inspect; insert it where it tests that hypothesis:\n\n${snippet}`,
            },
          ],
          details: { lang, endpoint },
        };
      }

      if (action === "read") {
        const limit = typeof params.limit === "number" ? params.limit : undefined;
        const text = store.formatForAgent(limit);
        return {
          content: [
            {
              type: "text" as const,
              text: `Captured ${store.size()} log entries${logFile ? ` (also at ${logFile})` : ""}:\n\n${text}`,
            },
          ],
          details: { count: store.size(), dropped: store.droppedCount(), logFile },
        };
      }

      if (action === "status") {
        const text = server.running
          ? `Collector running on 127.0.0.1:${server.port}; ${store.size()} entries captured.`
          : "Collector not running.";
        return {
          content: [{ type: "text" as const, text }],
          details: { running: server.running, port: server.port, count: store.size() },
        };
      }

      if (action === "clear") {
        store.clear();
        truncateFile();
        return { content: [{ type: "text" as const, text: "Cleared captured logs." }], details: { ok: true } };
      }

      // stop
      await server.stop();
      return {
        content: [
          {
            type: "text" as const,
            text: 'Debug log collector stopped. Remember to remove all instrumentation you added (search for the "[debug]" markers).',
          },
        ],
        details: { ok: true },
      };
    },
  });
}
