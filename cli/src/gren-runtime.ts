import {join} from "node:path";
import {guardModelInputLimits} from "./model-input-limits.js";
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
import { readRequestedPreferences, readSessionPreferences, type SessionPreferenceEntry } from "../../extensions/_shared/session-preferences.js";
import { installToolRefreshBatching } from "../../extensions/_shared/tool-refresh-batch.js";
import { attachSessionCwd } from "../../extensions/_shared/session-cwd.js";
import { filterExtensionsByProfile, filterManagedExtensions, type ExtensionProfile } from "./extension-profile.js";
import { observeModelRuntime } from "./observed-model-runtime.js";
import {ensureLegacyRoster} from "../../extensions/usage-ledger/legacyRoster.js";
import {attachUsageEntryTracking} from "../../extensions/usage-ledger/liveUsage.js";
import { attachCacheWarmingControl } from "./cache-warming-control.js";
import { attachModelCompactionControl } from "./model-compaction-control.js";

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
  prepareObservation?: (runtime:ModelRuntime,agentDir:string,manager:any)=>ModelRuntime;
  trackUsage?: typeof attachUsageEntryTracking;
}

const realDeps: GrenRuntimeDeps = {
  createAgentSessionServices,
  createAgentSessionFromServices,
  manifestExtensions,
  getConfig,
  prepareObservation:(runtime,agentDir,manager)=>{
    try{ensureLegacyRoster(agentDir);}catch{console.error('[usage-ledger] legacy provenance unavailable; reconciliation requires repair');}
    return observeModelRuntime(runtime,{identity:()=>({sessionId:manager.getSessionId(),sessionPath:manager.getSessionFile()})});
  },
  trackUsage:attachUsageEntryTracking,
};

/**
 * 会话日志里保存的“请求值”恢复成会话的初始选项。
 *
 * SDK 从 `model_change` / `thinking_level_change` 恢复出来的是**有效值**：setModel 会追加能力钳制后的
 * 档位（换到非推理模型就是 off），冷恢复只能看到这些。用户请求的 high 在 `session-preferences` 里，
 * 这里把它作为显式初始值传给会话工厂，SDK 再按当前模型钳一次（钳制结果只影响有效值，不改日志里的请求值）。
 *
 * - 模型不在当前目录里：不传 model（不能静默改用另一个模型），保留会话自己的日志。
 * - 没有 canonical 条目：完全交给 SDK，不干预旧会话恢复。
 */
type RestoredSessionOptions = Pick<Parameters<typeof createAgentSessionFromServices>[0], 'model' | 'thinkingLevel'>;

function restoredSessionOptions(
  modelRuntime: Pick<ModelRuntime, 'getModel' | 'hasConfiguredAuth'>,
  sessionManager: { getEntries?(): unknown[] },
): RestoredSessionOptions {
  const entries = typeof sessionManager?.getEntries === 'function' ? sessionManager.getEntries() : [];
  const source = (Array.isArray(entries) ? entries : []) as SessionPreferenceEntry[];
  const preferences = readRequestedPreferences(source);
  // 显式原生换模也必须恢复；thinking 仍保留 canonical 请求，避免 SDK 的 off/default 抹掉它。
  const selectedModel = preferences.model ? readSessionPreferences(source).model ?? preferences.model : undefined;
  const restored: RestoredSessionOptions = {};
  if (selectedModel) {
    const model = modelRuntime?.getModel?.(selectedModel.provider, selectedModel.id);
    const authOk = typeof modelRuntime?.hasConfiguredAuth === 'function'
      ? modelRuntime.hasConfiguredAuth(selectedModel.provider)
      : true;
    if (model && authOk) restored.model = model;
  }
  if (preferences.thinkingLevel) restored.thinkingLevel = preferences.thinkingLevel as RestoredSessionOptions['thinkingLevel'];
  return restored;
}

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
    services.modelRuntime=guardModelInputLimits((deps.prepareObservation??realDeps.prepareObservation!)(services.modelRuntime,agentDir,sessionManager),{modelsPath:join(agentDir,"models.json")});
    const created = await deps.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      ...restoredSessionOptions(services.modelRuntime, sessionManager),
    });
    (deps.trackUsage??realDeps.trackUsage!)(created.session,agentDir);
    attachCacheWarmingControl(created.session, cwd, agentDir);
    attachModelCompactionControl(created.session, cwd, agentDir);
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
