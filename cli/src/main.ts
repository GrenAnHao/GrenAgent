#!/usr/bin/env node
// GrenAgent — agent sidecar.
//
// pi runtime + our extensions compiled in (via extensionFactories). We reuse the
// official pi CLI entry (`main`) so the single sidecar binary supports every mode:
//   - Tauri (Rust) spawns it with `--mode rpc`  → runRpcMode (stdin/stdout JSONL RPC)
//   - sub-agents / memory-extract spawn it with
//     `--mode json -p --no-session <task>`      → runPrintMode (single-shot)
//
// No TUI here — the desktop UI is the Tauri front-end. No `-e` / no global `pi`
// install — the extensions are bundled into this sidecar binary.
//
// `main(args, { extensionFactories })` mirrors the official `dist/cli.js`
// (`main(process.argv.slice(2))`), plus our compiled-in extensions. API per pi 0.78.x.

import { main } from "@earendil-works/pi-coding-agent";
import { allExtensions } from "../../extensions/index.js";

main(process.argv.slice(2), { extensionFactories: allExtensions }).catch((error) => {
  console.error(error);
  process.exit(1);
});
