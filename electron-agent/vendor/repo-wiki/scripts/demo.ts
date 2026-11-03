import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { RepoWikiProcessClient } from "../packages/process/src/client.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const target = path.join(root, ".runtime/atlas-service");
// A second, genuinely empty knowledge workspace demonstrates the collection's
// ungenerated filter. These tiny authored fixtures are not user repositories.
const notesTarget = path.join(root, ".runtime/workspace-notes");
if (!fs.existsSync(notesTarget)) {
  fs.mkdirSync(path.join(notesTarget, "src"), {recursive: true});
  fs.writeFileSync(path.join(notesTarget, "README.md"), "# Workspace Notes\n\nSynthetic local RepoWiki example. A tiny in-memory note store; no model calls and no external services.\n");
  fs.writeFileSync(path.join(notesTarget, "src", "notes.ts"), "export class Notes {\n  private items = new Map<string, string>();\n  save(id: string, text: string) { this.items.set(id, text); }\n  read(id: string) { return this.items.get(id); }\n}\n");
}
if (!fs.existsSync(target)) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, "examples/atlas-service"), target, {
    recursive: true,
  });
  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    [
      "-c",
      "user.name=RepoWiki Demo",
      "-c",
      "user.email=demo@localhost",
      "commit",
      "-m",
      "Local TypeScript demo fixture",
    ],
  ])
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=" +
          (process.platform === "win32" ? "NUL" : "/dev/null"),
        "-C",
        target,
        ...args,
      ],
      { stdio: "ignore" },
    );
}
const client = new RepoWikiProcessClient({
  entry: path.join(root, "dist/packages/process/src/child.js"),
  dataDir: path.join(root, ".repowiki-node"),
  demoPath: target,
  cwd: root,
});
try {
  await client.start();
  const project = await client.invoke("create", {
    path: target,
    name: "Atlas Service · TypeScript",
  });
  const ungenerated = await client.invoke("create", {path: notesTarget, name: "Workspace Notes · 示例"});
  await client.invoke("generate", { project_id: project.id, provider: "demo" });
  let run;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = await client.invoke("run", { project_id: project.id });
  } while (["queued", "running", "cancel_requested"].includes(run.status));
  if (run.status !== "completed") throw new Error("Demo generation failed");
  console.log(
    JSON.stringify(
      {
        project_id: project.id,
        ungenerated_project_id: ungenerated.id,
        service_pid: client.pid,
        provider: "offline-demo",
        data_dir: ".repowiki-node",
        run,
      },
      null,
      2,
    ),
  );
} finally {
  await client.stop();
}
if (process.argv.includes("--serve")) {
  const child = spawn(
    process.execPath,
    [path.join(root, "dist/packages/service/src/cli.js")],
    { stdio: "inherit", cwd: root },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 0));
}
