import assert from "node:assert/strict";
import { test } from "node:test";
import {
  managedSkillLoaderOptions,
  reloadManagedSkills,
  withManagedSkillArgs,
} from "./tencentdb-skills.js";

test("RPC resource loader disables discovered skills and loads only TencentDB managed root", () => {
  assert.deepEqual(managedSkillLoaderOptions("C:/managed/skills"), {
    noSkills: true,
    additionalSkillPaths: ["C:/managed/skills"],
  });
  assert.deepEqual(managedSkillLoaderOptions(undefined), {
    noSkills: true,
    additionalSkillPaths: [],
  });
});

test("non-RPC arguments replace every caller-provided skill path with the managed root", () => {
  assert.deepEqual(
    withManagedSkillArgs(
      ["--skill", "C:/user/skill", "--mode", "json", "-p", "task"],
      "C:/managed/skills",
    ),
    ["--no-skills", "--skill", "C:/managed/skills", "--mode", "json", "-p", "task"],
  );
  assert.deepEqual(withManagedSkillArgs(["-ns", "--mode", "json", "task"], undefined), [
    "--no-skills",
    "--mode",
    "json",
    "task",
  ]);
});

test("hot reload synchronizes TencentDB skills before reloading Pi resources", async () => {
  const calls: string[] = [];
  await reloadManagedSkills(
    async () => {
      calls.push("sync");
    },
    async () => {
      calls.push("reload");
    },
  );
  assert.deepEqual(calls, ["sync", "reload"]);
});
