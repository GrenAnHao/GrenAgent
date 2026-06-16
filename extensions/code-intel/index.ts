// Code Intelligence 扩展入口：注册 explore_context（只读探索子代理）。
// 引擎内置 / 默认 MCP 注入在 Phase 1（mcp 扩展 + engines.ts）已完成；本入口聚焦工具层。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { registerExploreContext } from "./explorer.js";

export default function (pi: ExtensionAPI): void {
  // 子代理内不注册（防嵌套探索 + 保持子代理轻量），与 multi-agent/workflows 同款守卫。
  if (process.env.PI_IS_SUBAGENT === "1") return;
  // CODE_INTEL_EXPLORER=0 关闭（默认开）。
  if ((getConfig("CODE_INTEL_EXPLORER") ?? "1") === "0") return;
  registerExploreContext(pi);
}
