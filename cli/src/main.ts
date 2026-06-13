#!/usr/bin/env node
// GrenAgent — agent sidecar (RPC mode).
//
// pi runtime + our 8 extensions compiled in (via extensionFactories), running in
// RPC mode. The Tauri (Rust) backend spawns this process and talks to it over
// stdin/stdout using pi's JSONL RPC protocol (prompt / steer / abort / get_state / ...).
//
// No TUI here — the desktop UI is your Tauri front-end. No -e / no pi install —
// the extensions are bundled into this sidecar binary.
//
// API per pi 0.78.x. If you bump pi, diff against packages/coding-agent/src/main.ts
// (the `--mode rpc` branch) and adjust createAgentSessionServices options as needed.

import {
  AuthStorage,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { allExtensions } from "../../extensions/index.js";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoaderOptions: {
      // ← extensions compiled into the sidecar; not discovered/installed.
      extensionFactories: allExtensions,
    },
  });

  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

async function main(): Promise<void> {
  const cwd = process.cwd();

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(cwd),
  });

  // Takes over stdout, reads JSONL commands from stdin, streams events out.
  await runRpcMode(runtime);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
