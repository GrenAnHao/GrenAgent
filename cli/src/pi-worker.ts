import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import { applyOfficialMainPackageDir } from "./official-package-dir.js";

/** subagent：常驻子代理 worker，经 IPC RPC 托管一个子会话（extensions/multi-agent/worker-host.ts）。 */
export type WorkerMode = "json" | "print" | "subagent";

export function resolveWorkerMode(argv: string[]): WorkerMode {
  const i = argv.indexOf("--mode");
  if (i < 0 || argv[i + 1] === undefined) return "print";
  if (argv[i + 1] === "json") return "json";
  if (argv[i + 1] === "subagent") return "subagent";
  throw new Error(`pi-worker does not support rpc mode (got "${argv[i + 1]}").`);
}

function onPipeError(err: NodeJS.ErrnoException | undefined): void {
  if (err?.code === "EPIPE") process.exit(0);
}

export async function runWorker(): Promise<void> {
  const argv = process.argv.slice(2);
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  process.on("uncaughtException", onPipeError);
  process.on("unhandledRejection", (reason) => onPipeError(reason as NodeJS.ErrnoException));
  const mode = resolveWorkerMode(argv);
  applyOfficialMainPackageDir(process.env);
  if (mode === "subagent") {
    const { runSubagentWorker } = await import("../../extensions/multi-agent/worker-host.js");
    await runSubagentWorker();
    return;
  }
  const [{ main }, { allExtensions }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("../../extensions/index.js"),
  ]);
  // 1.0.2 的 MainOptions 只有 extensionFactories，没有 --extensions。
  // main() 会把 builtInExtensions 放在前面；同名且 builtin: true 的后项覆盖这张 Map，
  // 空工厂替换 builtin:mcp，因此不会执行 createMcpExtension。
  // 不在这里追加 codemode / tool_search：main() 的内置扩展已经各加载一次。
  const extensionFactories: InlineExtension[] = [...allExtensions, { name: "mcp", builtin: true, factory() {} }];
  await main(argv, { extensionFactories });
}
