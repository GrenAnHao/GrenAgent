import assert from "node:assert/strict";
import { test } from "node:test";
import {
  managedSkillLoaderOptions,
  reloadManagedSkills,
  withManagedSkillArgs,
} from "./tencentdb-skills.js";

test("RPC resource loader keeps native discovery and adds TencentDB managed root", () => {
  assert.deepEqual(managedSkillLoaderOptions("C:/managed/skills"), {
    noSkills: false,
    additionalSkillPaths: ["C:/managed/skills"],
  });
  assert.deepEqual(managedSkillLoaderOptions(undefined), {
    noSkills: false,
    additionalSkillPaths: [],
  });
});

test("non-RPC arguments preserve native flags and add the managed root", () => {
  assert.deepEqual(
    withManagedSkillArgs(
      ["--skill", "C:/user/skill", "--mode", "json", "-p", "task"],
      "C:/managed/skills",
    ),
    ["--skill", "C:/user/skill", "--mode", "json", "-p", "task", "--skill", "C:/managed/skills"],
  );
  assert.deepEqual(withManagedSkillArgs(["-ns", "--mode", "json", "task"], undefined), [
    "-ns", "--mode", "json", "task",
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
