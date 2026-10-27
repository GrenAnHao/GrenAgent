// Product path: grantSandboxAccess with the default io against a real large workspace.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantKey, grantSandboxAccess, SANDBOX_USERNAME } from "../../../extensions/_shared/sandbox/windows/account.ts";
import { defaultIo } from "../../../extensions/_shared/sandbox/windows/account.ts";

const workspace = process.argv[2];
if (!workspace) throw new Error("usage: live-grant.mts <workspace>");
const tempDir = join(tmpdir(), "pi-sandbox", "live-grant-timeout");
mkdirSync(tempDir, { recursive: true });
const io = defaultIo();
const t0 = Date.now();
await grantSandboxAccess(SANDBOX_USERNAME, { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "live-grant" }, tempDir, io);
const first = Date.now() - t0;
const grants = await io.readGrants(io.grantsPath());
console.log(`first call: ${first} ms, record = ${grants[grantKey(workspace)]}`);
const t1 = Date.now();
await grantSandboxAccess(SANDBOX_USERNAME, { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "live-grant" }, tempDir, io);
console.log(`second call (cached): ${Date.now() - t1} ms`);
