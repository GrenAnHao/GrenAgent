// Puts a workspace back to "never granted": revoke the way reclaim does, then drop its records from grants.json.
import { execFileSync } from "node:child_process";
import { defaultIo, grantKey, SANDBOX_USERNAME } from "../../../extensions/_shared/sandbox/windows/account.ts";
import { revokeArgs } from "../../../extensions/_shared/sandbox/windows/reclaim.ts";

const workspace = process.argv[2];
if (!workspace) throw new Error("usage: reset-workspace.mts <workspace>");
const t0 = Date.now();
execFileSync(`${process.env.SystemRoot}\\System32\\icacls.exe`, revokeArgs(workspace, SANDBOX_USERNAME), { stdio: "ignore" });
console.log(`revoke (/remove:g /T): ${Date.now() - t0} ms`);
const io = defaultIo();
const grants = await io.readGrants(io.grantsPath());
const key = grantKey(workspace);
for (const record of Object.keys(grants)) {
  if (record === key || record.endsWith(`:${key}`)) delete grants[record];
}
await io.writeGrants(io.grantsPath(), grants);
console.log(`records left for workspace: ${Object.keys(grants).filter((r) => r.includes(key)).length}`);
