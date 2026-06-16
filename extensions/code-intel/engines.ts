// 代码图谱引擎注册表。纯元数据 + 纯函数，无 I/O，便于测试与互换。
import type { McpServerConfig } from "../mcp/config.js";

export interface CodeIntelEngine {
  /** 注入用的规范 MCP server 名（也是让位判定的同名键）。 */
  serverName: string;
  /** 该引擎暴露的工具前缀，用于「签名识别」用户自配同类引擎。 */
  toolPrefix: string;
  /** 由捆绑目录与平台构建 stdio McpServerConfig。 */
  buildConfig: (pkgDir: string, platform: string) => McpServerConfig;
}

function binPath(pkgDir: string, base: string, platform: string): string {
  const ext = platform === "win32" ? ".exe" : "";
  // pkgDir 由 PI_PACKAGE_DIR 提供（sidecar.rs 指向 binaries/）。
  return `${pkgDir.replace(/[\\/]+$/, "")}/${base}${ext}`;
}

const ENGINES: Record<string, CodeIntelEngine> = {
  codegraph: {
    serverName: "codegraph",
    toolPrefix: "codegraph_",
    buildConfig: (pkgDir, platform) => ({
      name: "codegraph",
      transport: "stdio",
      command: binPath(pkgDir, "codegraph", platform),
      args: ["serve", "--mcp"],
      env: {},
    }),
  },
  // GitNexus 为 Phase 4 opt-in 引擎，先登记元数据占位（buildConfig 待该阶段实现真实命令）。
  gitnexus: {
    serverName: "gitnexus",
    toolPrefix: "",
    buildConfig: (pkgDir, platform) => ({
      name: "gitnexus",
      transport: "stdio",
      command: binPath(pkgDir, "gitnexus", platform),
      args: ["mcp"],
      env: {},
    }),
  },
};

export function getEngine(name: string): CodeIntelEngine | undefined {
  return ENGINES[name];
}

export function listEngineNames(): string[] {
  return Object.keys(ENGINES);
}

/** 用户自配的某 server 暴露的工具是否命中某引擎签名（即便其 server 名不同）。 */
export function matchesEngineSignature(engineName: string, toolNames: string[]): boolean {
  const eng = ENGINES[engineName];
  if (!eng || !eng.toolPrefix) return false;
  return toolNames.some((t) => t.startsWith(eng.toolPrefix));
}
