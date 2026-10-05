/** 主进程 V8 老生代上限，固定 4GB。未写入启动参数时 Electron 停在约 1.5GB。 */
export const MAIN_OLD_SPACE_MB = 4096;

/** 必须出现在进程启动参数里。进了主进程再 appendSwitch 已经改不到这块堆。 */
export const MAIN_JS_FLAGS = `--js-flags=--max-old-space-size=${MAIN_OLD_SPACE_MB}`;

export function mainHeapArgPresent(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.includes("--max-old-space-size="));
}

/** electron-vite 用 ELECTRON_CLI_ARGS 启动 Electron。这条是固定的 4GB 上限，不随运行时再改。 */
export function installDevElectronHeapArg(env: NodeJS.ProcessEnv = process.env): void {
  const args = parseCliArgs(env.ELECTRON_CLI_ARGS);
  if (!mainHeapArgPresent(args)) args.push(MAIN_JS_FLAGS);
  env.ELECTRON_CLI_ARGS = JSON.stringify(args);
}

function parseCliArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}
