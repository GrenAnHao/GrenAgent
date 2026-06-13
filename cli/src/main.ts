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

  // RPC mode (Tauri) → our own runtime so skillsOverride can filter skills.
  if (isRpcMode(argv)) {
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
