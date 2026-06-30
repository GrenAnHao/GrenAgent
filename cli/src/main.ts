#!/usr/bin/env node
// GrenAgent — agent sidecar.
//
// Hybrid runtime so we get the best of both:
//   - `--mode rpc` (Tauri backend): build the runtime ourselves so we can pass
//     `skillsOverride` and filter out skills disabled via SKILLS_DISABLED.
//   - everything else (sub-agents/memory-extract `--mode json -p`, etc.): reuse
//     the official `main(argv, { extensionFactories })` which handles print mode.
//
// pi runtime + our extensions are compiled into this binary (extensionFactories);
// no `-e` / no global `pi` install needed. API per pi 0.78.x.

import {
  AuthStorage,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  main,
  ModelRegistry,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { allExtensions, namedExtensions, safety } from "../../extensions/index.js";
import { getConfig, watchConfig } from "../../extensions/_shared/runtime-config.js";
import { filterExtensionsByProfile, type ExtensionProfile } from "./extension-profile.js";

// Distinctive startup marker on stderr. The Tauri backend (pi/sidecar.rs) probes
// for it after spawn: if absent, the spawned `pi` is likely a plain upstream
// binary WITHOUT our compiled-in guardrails (safety/permission), so the
// backend warns loudly. `safety=on` additionally confirms the security extension
// is in the bundle (it is, by static import — this is a tripwire, not a gate).
function emitReadyBanner(): void {
  const safetyOn = allExtensions.includes(safety);
  console.error(`[grenagent-sidecar] ready ext=${allExtensions.length} safety=${safetyOn ? "on" : "OFF"}`);
}

// On shutdown the parent (Tauri) closes the stdio/RPC pipe; in-flight writes then
// fail with EPIPE. A broken pipe means the parent is gone, so the sidecar should
// just exit cleanly.
function onPipeError(err: NodeJS.ErrnoException | undefined): void {
  if (err?.code === "EPIPE") process.exit(0);
}
process.stdout.on("error", onPipeError);
process.stderr.on("error", onPipeError);
// EPIPE also arrives as an uncaughtException/rejection when a synchronous write
// hits the dead pipe. pi's runtime-failure guard catches those and keeps running,
// so it re-writes to the broken pipe forever and floods stderr (tens of thousands
// of "EPIPE: broken pipe" lines). Registered here at module load — before pi sets
// up its own guard — so we exit on the very first EPIPE instead of looping.
process.on("uncaughtException", onPipeError);
process.on("unhandledRejection", (reason) => onPipeError(reason as NodeJS.ErrnoException));

function isRpcMode(argv: string[]): boolean {
  const i = argv.indexOf("--mode");
  return i >= 0 && argv[i + 1] === "rpc";
}

// pi exposes skills as the `skill:<name>` command but the skill resource itself
// is keyed by the bare name. Normalize both the disabled list and each skill name
// to the bare form so the GUI's toggle matches regardless of which form it stored.
function bareSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice(6) : name;
}

// Skills the user disabled in the GUI (comma-separated names via SKILLS_DISABLED).
// Read at call time from the runtime config (falls back to env) so a session
// reload picks up live toggles without restarting the sidecar.
function disabledSkills(): Set<string> {
  return new Set(
    (getConfig("SKILLS_DISABLED") ?? "")
      .split(",")
      .map((s) => bareSkillName(s.trim()))
      .filter(Boolean),
  );
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoaderOptions: {
      // 按 EXTENSIONS_PROFILE 过滤：真对话模式（chat）裁掉重代码智能扩展以加速冷启动；默认 project 全载。
      // safety 永不剔除（见 filterExtensionsByProfile）。
      extensionFactories: filterExtensionsByProfile(
        namedExtensions,
        (getConfig("EXTENSIONS_PROFILE") as ExtensionProfile) ?? "project",
      ).map((x) => x.factory),
      // Provided unconditionally so every resourceLoader.reload() re-reads the live
      // disabled list — GUI skill toggles take effect on reload, no sidecar restart.
      skillsOverride: (base) => {
        const disabled = disabledSkills();
        if (disabled.size === 0) return base;
        return {
          skills: base.skills.filter((s) => !disabled.has(bareSkillName(s.name))),
          diagnostics: base.diagnostics,
        };
      },
    },
  });

  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

async function run(): Promise<void> {
  const argv = process.argv.slice(2);

  emitReadyBanner();

  // 一次性探测子命令（管理面板「测试连接」用）：不启动 pi 运行时，仅连 MCP server 取工具名。
  if (argv[0] === "probe-mcp") {
    const { runProbeCli } = await import("../../extensions/mcp/probe.js");
    await runProbeCli();
    return;
  }

  // 一次性列模型（管理面板 / 冷启动 / 真对话模式用）：不启动 pi 运行时，仅建 ModelRegistry 列模型。
  if (argv[0] === "probe-models") {
    const { runModelProbe } = await import("./probe-models.js");
    await runModelProbe();
    return;
  }

  // 一次性 LLM 调用（mermaid 修复 / 模型健康检查用）：走 pi-ai dispatch，不进对话。逻辑在 extensions/_shared
  // （pi-ai 在那解析），与 probe-mcp 同构。读 ONESHOT_REQUEST（JSON），结果打 stdout（流式为 JSONL）。
  if (argv[0] === "oneshot") {
    const { runOneshot } = await import("../../extensions/_shared/oneshot.js");
    await runOneshot();
    return;
  }

  // RPC mode (Tauri) → our own runtime so skillsOverride can filter skills.
  if (isRpcMode(argv)) {
    // Orphan guard: stdin is our RPC command channel and the parent (Tauri) keeps
    // it open for as long as it lives. When the parent dies — graceful close, crash,
    // or force-kill — the OS closes its end of the pipe and our stdin hits EOF. That
    // is a reliable "parent is gone" signal even while we're idle (awaiting the next
    // command) or blocked on a network call, cases where the EPIPE-on-write guard
    // above never fires. Exit so we don't linger as an orphan process.
    //
    // We don't resume() stdin here: runRpcMode owns the read side and putting the
    // stream into flowing mode before it attaches its reader could drop early
    // commands. These listeners fire once runRpcMode starts reading and hits EOF.
    const exitOnParentGone = () => process.exit(0);
    process.stdin.on("end", exitOnParentGone);
    process.stdin.on("close", exitOnParentGone);

    const cwd = process.cwd();
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    });

    // Resource hot-reload: the GUI bumps PI_RELOAD_REV in runtime-settings.json on
    // changes that need extensions/skills re-evaluated (skill toggle/create/delete/
    // import, explore_context toggle). On change, reload the session's resources +
    // system prompt in place via AgentSession.reload() — no sidecar restart,
    // conversation preserved. Deferred to idle so an in-flight turn isn't interrupted.
    // (MCP servers and the code-intel engine hot-reload via the mcp manager's own
    // watch, so they don't need a session reload.)
    let lastReloadRev = getConfig("PI_RELOAD_REV") ?? "";
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadResources = (): void => {
      const session = runtime.session;
      const doReload = (): Promise<void> =>
        runtime.session.reload().catch((e) => {
          console.error("[reload] session reload failed:", e);
        });
      if (!session.isStreaming) {
        void doReload();
        return;
      }
      // Mid-turn: wait for the current turn to finish, then reload once.
      const unsub = session.subscribe((ev) => {
        if (ev.type === "agent_end" && !ev.willRetry) {
          unsub();
          void doReload();
        }
      });
    };
    const unwatchReload = watchConfig((next) => {
      const rev = next.PI_RELOAD_REV ?? "";
      if (rev === lastReloadRev) return;
      lastReloadRev = rev;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadResources, 150);
    });
    process.on("exit", () => unwatchReload());

    await runRpcMode(runtime);
    return;
  }

  // Everything else (sub-agent print/json, interactive, --help, ...) → official CLI.
  await main(argv, { extensionFactories: allExtensions });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
