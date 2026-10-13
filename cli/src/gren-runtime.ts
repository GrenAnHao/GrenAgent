import {
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import { manifestExtensions } from "../../extensions/index.js";
import { getConfig } from "../../extensions/_shared/runtime-config.js";
import { installToolRefreshBatching } from "../../extensions/_shared/tool-refresh-batch.js";
import { attachSessionCwd } from "../../extensions/_shared/session-cwd.js";
import { filterExtensionsByProfile, filterManagedExtensions, type ExtensionProfile } from "./extension-profile.js";

function bareSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice(6) : name;
}

/** Native Skill toggle. Read on every reload so the UI does not need a restart. */
function disabledSkills(getConfigFn: (key: string) => string | undefined): Set<string> {
  return new Set(
    (getConfigFn("SKILLS_DISABLED") ?? "")
      .split(",")
      .map((name) => bareSkillName(name.trim()))
      .filter(Boolean),
  );
}

export interface GrenRuntimeDeps {
  createAgentSessionServices: typeof createAgentSessionServices;
  createAgentSessionFromServices: typeof createAgentSessionFromServices;
  manifestExtensions: typeof manifestExtensions;
  getConfig: (key: string) => string | undefined;
}

const realDeps: GrenRuntimeDeps = {
  createAgentSessionServices,
  createAgentSessionFromServices,
  manifestExtensions,
  getConfig,
};

export interface GrenRuntimeOptions {
  /** 进程内共享的 ModelRuntime。省略则由 createAgentSessionServices 自建（worker 场景）。 */
  modelRuntime?: ModelRuntime;
  /** PI_ALLOWED_EXTENSIONS 的 JSON 字符串（全局白名单）。省略走 getConfig 回退。 */
  allowedExtensionsJson?: string;
  /**
   * 接在托管扩展后面。省略时用官方 createCodemodeExtension() 与 createToolSearchExtension()。
   * 单测传入自己的数组，避免执行官方 codemode（wasm 在首次调用时加载）。
   */
  extraFactories?: ExtensionFactory[];
  /** 仅测试注入。 */
  deps?: GrenRuntimeDeps;
}

/**
 * Electron 主进程宿主与 pi-worker 子进程共用的 runtime 工厂。
 * 从 cli/src/runtime.ts 抽出；不带入 runtime.ts 的 process.on 静默吞错钩子。
 */
export function makeGrenRuntimeFactory(options: GrenRuntimeOptions = {}): CreateAgentSessionRuntimeFactory {
  const deps = options.deps ?? realDeps;
  const getConfigFn = deps.getConfig;
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const allowedJson = options.allowedExtensionsJson ?? getConfigFn("PI_ALLOWED_EXTENSIONS");
    const services = await deps.createAgentSessionServices({
      cwd,
      agentDir,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      resourceLoaderOptions: {
        extensionFactories: getConfigFn("PI_SYSTEM_WORKER") === "1"
          ? []
          : [
              ...filterManagedExtensions(
                filterExtensionsByProfile(
                  deps.manifestExtensions,
                  (getConfigFn("EXTENSIONS_PROFILE") as ExtensionProfile) ?? "project",
                ),
                allowedJson,
              ).map((x) => x.factory),
              ...(options.extraFactories ?? [createCodemodeExtension(), createToolSearchExtension()]),
            ],
        noContextFiles: getConfigFn("PI_DISABLE_PROJECT_CONTEXT") === "1",
        skillsOverride: (base) => {
          const disabled = disabledSkills(getConfigFn);
          if (disabled.size === 0) return base;
          return {
            skills: base.skills.filter((skill) => !disabled.has(bareSkillName(skill.name))),
            diagnostics: base.diagnostics,
          };
        },
      },
    });
    const created = await deps.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    // 绑定扩展（session_start 里 MCP 首次投影一批工具）之前装上，批量注册时工具表只刷新一次。
    installToolRefreshBatching(created.session);
    // 服务仍按原始目录建：runtime.cwd 决定之后 newSession / fork 的会话头，必须是原始目录。
    // 会话切过工作目录的，由 attachSessionCwd 按会话里的记录原地切回去。
    attachSessionCwd(created.session);
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };
}
