import {
  type CreateAgentSessionRuntimeFactory,
  type ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { manifestExtensions } from "../../extensions/index.js";
import { getConfig } from "../../extensions/_shared/runtime-config.js";
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
          : filterManagedExtensions(
              filterExtensionsByProfile(
                deps.manifestExtensions,
                (getConfigFn("EXTENSIONS_PROFILE") as ExtensionProfile) ?? "project",
              ),
              allowedJson,
            ).map((x) => x.factory),
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
    return {
      ...(await deps.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}
