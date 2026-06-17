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
import { allExtensions } from "../../extensions/index.js";

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

// Skills the user disabled in the GUI (comma-separated names via SKILLS_DISABLED).
function disabledSkills(): Set<string> {
  return new Set(
    (process.env.SKILLS_DISABLED ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const disabled = disabledSkills();

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoaderOptions: {
      extensionFactories: allExtensions,
      skillsOverride:
        disabled.size === 0
          ? undefined
          : (base) => ({
              skills: base.skills.filter((s) => !disabled.has(s.name)),
              diagnostics: base.diagnostics,
            }),
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

  // 一次性探测子命令（管理面板「测试连接」用）：不启动 pi 运行时，仅连 MCP server 取工具名。
  if (argv[0] === "probe-mcp") {
    const { runProbeCli } = await import("../../extensions/mcp/probe.js");
    await runProbeCli();
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
