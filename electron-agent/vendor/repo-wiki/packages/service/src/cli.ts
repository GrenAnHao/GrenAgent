/** Optional HTTP preview launcher; the real service always runs in a separate OS process. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepoWikiProcessClient } from "../../process/src/client.js";
import { createHttpServer } from "./http.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
}
const host = option("--host", "127.0.0.1"),
  port = Number(option("--port", "8765"));
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error("Use a loopback host and valid port");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("REPOWIKI_")),
);
const client = new RepoWikiProcessClient({
  entry: path.join(root, "dist/packages/process/src/child.js"),
  dataDir: path.resolve(
    option(
      "--data-dir",
      process.env.REPOWIKI_DATA_DIR ?? path.join(root, ".repowiki-node"),
    ),
  ),
  env,
  demoPath: path.join(root, "examples/atlas-service"),
  cwd: root,
});
await client.start();
const server = createHttpServer(client, path.join(root, "apps/web/dist"));
server.listen(port, host, () =>
  console.log(
    `Gren RepoWiki TypeScript preview: http://${host}:${port} — service PID ${client.pid}; local only`,
  ),
);
let stopped = false;
async function close() {
  if (stopped) return;
  stopped = true;
  server.close();
  server.closeAllConnections();
  await client.stop();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void close().finally(() => process.exit(0)));
server.on("error", () => void close().finally(() => process.exit(1)));
