// 命令模板文件：<agentDir>/prompts/<名>.md，即 Pi 原生 prompt template。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parsePromptParams, type PromptParam } from "./syntax.js";

export interface PromptTemplate {
  name: string;
  description: string;
  body: string;
  params: PromptParam[];
}

export function promptsDir(agentDir: string): string {
  return join(agentDir, "prompts");
}

/** 文件名主干不能带路径分隔符，也不能是 . 或 ..，防止越出目录。 */
export function isSafeFileStem(stem: string): boolean {
  return stem.length > 0 && stem !== "." && stem !== ".." && !/[\/]/.test(stem);
}

export function parseTemplate(name: string, content: string): PromptTemplate {
  const { frontmatter, body } = parseFrontmatter<{ description?: unknown }>(content);
  return {
    name,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    body,
    params: parsePromptParams(body),
  };
}

export function loadTemplate(agentDir: string, name: string): PromptTemplate | null {
  if (!isSafeFileStem(name)) return null;
  try {
    return parseTemplate(name, readFileSync(join(promptsDir(agentDir), `${name}.md`), "utf8"));
  } catch {
    return null;
  }
}
