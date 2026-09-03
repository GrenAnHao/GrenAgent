import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  main,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { allExtensions, manifestExtensions, safety } from "../../extensions/index.js";
import { getConfig, watchConfig } from "../../extensions/_shared/runtime-config.js";
import { onResourceReloadRequested } from "../../extensions/_shared/resource-reload.js";
import { filterExtensionsByProfile, filterManagedExtensions, type ExtensionProfile } from "./extension-profile.js";

function emitReadyBanner(): void {
  const safetyOn = allExtensions.includes(safety);
  console.error(`[grenagent-sidecar] ready ext=${allExtensions.length} safety=${safetyOn ? "on" : "OFF"}`);
}

function onPipeError(err: NodeJS.ErrnoException | undefined): void {
  if (err?.code === "EPIPE") process.exit(0);
}
process.stdout.on("error", onPipeError);
process.stderr.on("error", onPipeError);
process.on("uncaughtException", onPipeError);
process.on("unhandledRejection", (reason) => onPipeError(reason as NodeJS.ErrnoException));

function isRpcMode(argv: string[]): boolean {
  const i = argv.indexOf("--mode");
  return i >= 0 && argv[i + 1] === "rpc";
}

function bareSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice(6) : name;
}

/** Native Skill toggle. Read on every reload so the UI does not need a restart. */
function disabledSkills(): Set<string> {
  return new Set(
    (getConfig("SKILLS_DISABLED") ?? "")
      .split(",")
      .map((name) => bareSkillName(name.trim()))
      .filter(Boolean),
  );
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      // 按 EXTENSIONS_PROFILE 过滤：真对话模式（chat）裁掉重代码智能扩展以加速冷启动；默认 project 全载。
      // safety 永不剔除（见 filterExtensionsByProfile）。
      extensionFactories: getConfig('PI_SYSTEM_WORKER') === '1' ? [] : filterManagedExtensions(filterExtensionsByProfile(
        manifestExtensions,
        (getConfig("EXTENSIONS_PROFILE") as ExtensionProfile) ?? "project",
      ), getConfig('PI_ALLOWED_EXTENSIONS')).map((x) => x.factory),
      noContextFiles: getConfig('PI_DISABLE_PROJECT_CONTEXT') === '1',
      skillsOverride: (base) => {
        const disabled = disabledSkills();
        if (disabled.size === 0) return base;
        return {
          skills: base.skills.filter((skill) => !disabled.has(bareSkillName(skill.name))),
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

export async function run(): Promise<void> {
  const argv = process.argv.slice(2);

  emitReadyBanner();

  if (argv[0] === "probe-mcp") {
    const { runProbeCli } = await import("../../extensions/mcp/probe.js");
    await runProbeCli();
    return;
  }

  if (argv[0] === "probe-models") {
    const { runModelProbe } = await import("./probe-models.js");
    await runModelProbe();
    return;
  }

  if (argv[0] === "oneshot") {
    const { runOneshot } = await import("../../extensions/_shared/oneshot.js");
    await runOneshot();
    return;
  }

  if (isRpcMode(argv)) {
    const exitOnParentGone = () => process.exit(0);
    process.stdin.on("end", exitOnParentGone);
    process.stdin.on("close", exitOnParentGone);

    const cwd = process.cwd();
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    });

    let lastReloadRev = getConfig("PI_RELOAD_REV") ?? "";
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let reloadPending = false;
    const reloadResources = (): void => {
      if (reloadPending) return;
      reloadPending = true;
      const session = runtime.session;
      const doReload = (): Promise<void> =>
        runtime.session.reload().catch((e) => {
          console.error("[reload] session reload failed:", e);
        }).finally(() => {
          reloadPending = false;
        });
      if (!session.isStreaming) {
        void doReload();
        return;
      }
      const unsub = session.subscribe((ev) => {
        if (ev.type === "agent_end" && !ev.willRetry) {
          unsub();
          void doReload();
        }
      });
    };
    const unwatchResourceReload = onResourceReloadRequested(reloadResources);
    const unwatchReload = watchConfig((next) => {
      const rev = next.PI_RELOAD_REV ?? "";
      if (rev === lastReloadRev) return;
      lastReloadRev = rev;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadResources, 150);
    });
    process.on("exit", () => { unwatchReload(); unwatchResourceReload(); });

    await runRpcMode(runtime);
    return;
  }

  await main(argv, { extensionFactories: allExtensions });
}
