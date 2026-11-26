import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import { frontendOnlyHmr, ignoreNonFrontendWatch } from "./frontendWatch";

it("serves new named exports at the same /@fs URL in an already-warm renderer", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "usage hmr-")));
  const root = join(repo, "electron-agent");
  const lib = join(root, "src", "lib");
  const extension = join(repo, "extensions", "usage-ledger");
  const contract = join(extension, "analytics.ts");
  const facade = join(lib, "usageReport.ts");
  const facadeSource = (names: string) =>
    `export { ${names} } from "../../../extensions/usage-ledger/analytics.js";\nif (import.meta.hot) import.meta.hot.accept();`;
  let vite: ViteDevServer | undefined;
  try {
    await Promise.all([mkdir(lib, {recursive:true}), mkdir(extension, {recursive:true})]);
    await writeFile(contract, "export const original = 1;");
    await writeFile(facade, facadeSource("original"));
    vite = await createServer({
      root, configFile: false, envFile: false, logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] },
        watch: { ignored: path => ignoreNonFrontendWatch(path, root) } },
      plugins: [frontendOnlyHmr(root)],
    });
    await vite.listen();
    const origin = vite.resolvedUrls!.local[0];
    const read = async (path: string) => {
      const response = await fetch(new URL(path, origin));
      expect(response.status).toBe(200);
      return (await response.text()).split("//# sourceMappingURL=")[0];
    };
    const entry = "/src/lib/usageReport.ts";
    const moduleUrl = (await read(entry)).match(/from\s+["']([^"']+\/analytics\.ts)["']/)?.[1];
    expect(moduleUrl).toContain("/@fs/");
    expect(await read(moduleUrl!)).not.toContain("CALL_PAGE_SIZE");
    await vi.waitFor(() => expect(Object.values(vite!.watcher.getWatched()).flat()).toContain("analytics.ts"));

    const next = "export const original = 1; export const CALL_PAGE_SIZE = 20;";
    await writeFile(contract + ".tmp", next);
    await rename(contract + ".tmp", contract);
    await writeFile(facade, facadeSource("original, CALL_PAGE_SIZE"));
    await vi.waitFor(async () => {
      expect(await read(entry)).toContain("CALL_PAGE_SIZE");
      expect(await read(moduleUrl!)).toMatch(/CALL_PAGE_SIZE\s*=\s*20/);
    }, {timeout: 4_000});

    // Two distinct editor saves, outside chokidar's 50ms change-event coalescing window.
    await delay(120);
    const broadcast = vi.spyOn(vite.environments.client.hot, "send");
    await writeFile(contract, next + " export function readCallQuery() {}");
    await vi.waitFor(async () => {
      expect(await read(moduleUrl!)).toContain("readCallQuery");
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: "update", updates: expect.arrayContaining([expect.objectContaining({ path: entry })]),
      }));
    }, { timeout: 4_000 });
  } finally {
    await vite?.close();
    await rm(repo, { recursive: true, force: true });
  }
}, 15_000);
