import { relative, resolve, sep } from "node:path";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function relativeToRoot(filePath: string, rendererRoot: string): string | null {
  const rel = relative(resolve(rendererRoot), resolve(filePath));
  if (rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

/** 渲染层热更只认这些路径：src 里的正式源码，以及 index.html。测试文件不算。 */
export function isFrontendHmrPath(filePath: string, rendererRoot: string): boolean {
  const rel = relativeToRoot(filePath, rendererRoot);
  if (!rel) return false;
  if (rel === "index.html") return true;
  if (!rel.startsWith("src/")) return false;
  return !TEST_FILE.test(rel);
}

/**
 * chokidar `ignored`：返回 true 表示不侦测。
 * 根目录和 src 下的目录必须返回 false，否则进不到前端文件。
 * electron/、out/、extensions/ 等整棵丢掉，避免工具和主进程改动触发渲染层刷新。
 */
export function ignoreNonFrontendWatch(filePath: string, rendererRoot: string): boolean {
  const rel = relativeToRoot(filePath, rendererRoot);
  if (rel == null) return true;
  if (rel === "") return false;
  if (rel === "index.html" || rel === "electron.vite.config.ts") return false;
  if (rel === "src" || rel.startsWith("src/")) return TEST_FILE.test(rel);
  return true;
}
