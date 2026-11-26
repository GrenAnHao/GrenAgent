import { relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// This module supplies JavaScript exports to the renderer as well as types to the agent host.
const USAGE_REPORT_CONTRACT = "../extensions/usage-ledger/analytics.ts";

function relativeToRoot(filePath: string, rendererRoot: string): string {
  return relative(resolve(rendererRoot), resolve(filePath)).split(sep).join("/");
}

function isRendererModule(rel: string): boolean {
  return rel === "index.html" || rel === USAGE_REPORT_CONTRACT ||
    (rel.startsWith("src/") && !TEST_FILE.test(rel));
}

export function isFrontendHmrPath(filePath: string, rendererRoot: string): boolean {
  return isRendererModule(relativeToRoot(filePath, rendererRoot));
}

/** Vite adds imported external files by exact path; no extension directory needs to be watched. */
export function ignoreNonFrontendWatch(filePath: string, rendererRoot: string): boolean {
  const rel = relativeToRoot(filePath, rendererRoot);
  return rel !== "" && rel !== "src" && rel !== "electron.vite.config.ts" && !isRendererModule(rel);
}

export function frontendOnlyHmr(rendererRoot: string): Plugin {
  return {
    name: "frontend-only-hmr",
    hotUpdate({ file }) {
      if (!isFrontendHmrPath(file, rendererRoot)) return [];
    },
  };
}
