import { type InlineExtension, main } from "@earendil-works/pi-coding-agent";
import { allExtensions, safety } from "../../extensions/index.js";

/**
 * 1.0.2 的 MainOptions 只有 extensionFactories，没有 --extensions。
 * main() 会把 builtInExtensions 放在前面；同名且 builtin: true 的后项覆盖这张 Map，
 * 空工厂替换 builtin:mcp，因此不会执行 createMcpExtension。
 * -builtin:mcp 是 settings 里的排除项，不是 CLI flag。argv 已包含该标记时不再追加。
 * 不在这里追加 codemode / tool_search：main() 的内置扩展已经各加载一次。
 */
function extensionFactoriesForMain(argv: string[]): InlineExtension[] {
  if (argv.some((arg) => arg === "-builtin:mcp" || arg.includes("-builtin:mcp"))) {
    return allExtensions;
  }
  return [...allExtensions, { name: "mcp", builtin: true, factory() {} }];
}

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

export async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  emitReadyBanner();
  await main(argv, { extensionFactories: extensionFactoriesForMain(argv) });
}
