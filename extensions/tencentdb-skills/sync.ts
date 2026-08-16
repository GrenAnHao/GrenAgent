import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { SkillClient, type SkillClientConfig } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

export interface SkillResource {
  path: string;
  content: string;
}

export interface RemoteSkill {
  id: string;
  version: number;
  markdown: string;
  resources: SkillResource[];
}

export interface SkillSyncResult {
  revision: string;
  synced: string[];
  removed: string[];
}

export function createSkillClient(config: SkillClientConfig): SkillClient {
  // Skill 同步发生在 sidecar 冷启动路径；给它独立的短请求预算，避免
  // 远程 Gateway 无响应时把整次会话卡在资源加载之前。
  const timeout = Number.parseInt(process.env.TDAI_SKILLS_REQUEST_TIMEOUT_MS ?? "4000", 10);
  return new SkillClient({
    ...config,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 4000,
  });
}

interface SkillManifest {
  revision: string;
  skills: Array<{ id: string; version: number }>;
}

function safeName(name: string): string {
  const value = name.trim();
  if (!value || value === "." || value === ".." || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`invalid TencentDB skill id: ${name}`);
  }
  return value;
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || isAbsolute(normalized)) {
    throw new Error(`skill resource path must be relative: ${path}`);
  }
  const clean = posix.normalize(normalized);
  if (clean === "." || clean === ".." || clean.startsWith("../") || clean.includes("/../")) {
    throw new Error(`skill resource path escapes managed root: ${path}`);
  }
  return clean;
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`path escapes managed TencentDB skill root: ${candidate}`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

async function readManifest(root: string): Promise<SkillManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(root, ".manifest.json"), "utf8")) as SkillManifest;
  } catch {
    return undefined;
  }
}

/**
 * 将远程 Skill 原子同步到专用缓存根目录。
 * 该根目录不与用户 ~/.pi/agent/skills 重叠，因此不会覆盖用户 Skill。
 */
export async function syncSkills(root: string, skills: RemoteSkill[]): Promise<SkillSyncResult> {
  const managedRoot = resolve(root);
  await mkdir(managedRoot, { recursive: true });
  const staging = join(managedRoot, `.staging-${randomUUID()}`);
  const previous = await readManifest(managedRoot);
  const previousIds = new Set(previous?.skills.map((skill) => skill.id) ?? []);
  const manifestSkills: SkillManifest["skills"] = [];

  try {
    await mkdir(staging, { recursive: true });
    for (const skill of skills) {
      const id = safeName(skill.id);
      const skillRoot = join(staging, id);
      assertInside(staging, skillRoot);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), skill.markdown, "utf8");
      for (const resource of skill.resources) {
        const resourcePath = safeRelativePath(resource.path);
        const destination = join(skillRoot, resourcePath);
        assertInside(skillRoot, destination);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, resource.content, "utf8");
      }
      await writeFile(join(skillRoot, ".version"), String(skill.version), "utf8");
      manifestSkills.push({ id, version: skill.version });
    }

    const nextIds = new Set(manifestSkills.map((skill) => skill.id));
    const removed = [...previousIds].filter((id) => !nextIds.has(id));
    for (const id of [...nextIds, ...removed]) {
      const staged = join(staging, id);
      const destination = join(managedRoot, id);
      assertInside(managedRoot, destination);
      if (nextIds.has(id)) {
        const backup = join(managedRoot, `.backup-${randomUUID()}`);
        try {
          await rename(destination, backup);
        } catch {
          // 首次同步时目标不存在。
        }
        await rename(staged, destination);
        await rm(backup, { recursive: true, force: true }).catch(() => {});
      } else {
        await rm(destination, { recursive: true, force: true });
      }
    }

    const manifestPayload = JSON.stringify({ skills: manifestSkills }, null, 2);
    const revision = createHash("sha256").update(manifestPayload).digest("hex");
    await atomicWrite(
      join(managedRoot, ".manifest.json"),
      JSON.stringify({ revision, skills: manifestSkills }, null, 2),
    );
    return { revision, synced: manifestSkills.map((skill) => skill.id), removed };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** 从 MemoryCore Skill API 拉取当前 Agent 的 active Skill 与资源文件。 */
export async function fetchRemoteSkills(
  client: SkillClient,
  identity: { teamId: string; agentId: string; userId: string },
): Promise<RemoteSkill[]> {
  const pageSize = 100;
  const summaries = [] as Awaited<ReturnType<SkillClient["list"]>>["items"];
  let offset = 0;
  while (true) {
    const page = await client.list({
      team_id: identity.teamId,
      agent_id: identity.agentId,
      user_id: identity.userId,
      filters: { status: ["active"], owner_agent_id: identity.agentId },
      pagination: { limit: pageSize, offset },
    });
    summaries.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || page.items.length < pageSize || offset >= page.total) break;
  }
  const result: RemoteSkill[] = [];
  for (const summary of summaries) {
    const detail = await client.get({
      skill_id: summary.skill_id,
      team_id: identity.teamId,
      agent_id: identity.agentId,
      user_id: identity.userId,
      include_content: true,
      include_manifest: true,
    });
    const resources: SkillResource[] = [];
    for (const entry of detail.manifest ?? []) {
      const file = await client.readFile({
        skill_id: summary.skill_id,
        version: detail.version,
        path: entry.path,
        team_id: identity.teamId,
        agent_id: identity.agentId,
        user_id: identity.userId,
      });
      resources.push({ path: file.path, content: file.content });
    }
    result.push({
      id: summary.skill_id,
      version: detail.version,
      markdown: detail.content ?? "",
      resources,
    });
  }
  return result;
}
