import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpConfigPaths, readLayeredMcpServers, writeMcpServer } from "./mcp-store.js";
import { installSkill } from "./skill-store.js";

describe("resource stores", () => {
  it("writes scoped MCP config atomically and merges project precedence", async () => {
    const home = await mkdtemp(join(tmpdir(), "resource-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "resource-ws-"));
    await writeMcpServer({ name: "same", scope: "global", transport: "stdio", command: "global" }, workspace, home);
    await writeMcpServer({ name: "same", scope: "project", transport: "stdio", command: "project", replace: true }, workspace, home);
    const servers = await readLayeredMcpServers(workspace, "", home);
    expect(servers.find((s) => s.name === "same")?.command).toBe("project");
    expect(JSON.parse(await readFile(mcpConfigPaths(workspace, home).global, "utf8")).mcpServers.same.command).toBe("global");
  });

  it("installs inline skills with generated frontmatter", async () => {
    const home = await mkdtemp(join(tmpdir(), "skill-home-"));
    const result = await installSkill({ name: "inline", source: { type: "content", content: "# Steps" }, description: "demo" }, home);
    expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toContain("name: inline");
  });

  it("copies directory skills and rejects duplicate without replace", async () => {
    const home = await mkdtemp(join(tmpdir(), "skill-home-"));
    const source = await mkdtemp(join(tmpdir(), "skill-source-"));
    await mkdir(join(source, "refs"));
    await writeFile(join(source, "SKILL.md"), "---\nname: copied\n---\n# Copied");
    await writeFile(join(source, "refs", "guide.md"), "guide");
    await installSkill({ name: "copied", source: { type: "directory", path: source } }, home);
    await expect(installSkill({ name: "copied", source: { type: "content", content: "# New" } }, home)).rejects.toThrow(/replace/);
  });
});
