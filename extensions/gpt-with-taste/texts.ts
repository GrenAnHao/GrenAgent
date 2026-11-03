// 行为文本加载：文本源自上游 NB-Corp/gpt-with-taste 的 recipe/（MIT，见同目录 LICENSE）。
//
// 文本是构建产物的一部分：源文件在 extensions/gpt-with-taste/texts/，打包后由
// copyPiAdjacentAssets 拷到 out/main/texts 与 out/main/chunks/texts（和 fable-behavior 的
// prompts 同一套路）。读不到只报错并返回 undefined，不能让加载失败把整个扩展搞崩。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 六份文本：main / sub / independent 三种角色 + 三种 steer。 */
export const TASTE_TEXT_FILES = {
  main: "main.md",
  sub: "sub.md",
  independent: "independent.md",
  userSteer: "user-steer.md",
  subSteer: "sub-steer.md",
  agentSteer: "agent-steer.md",
} as const;

export type TasteTextKey = keyof typeof TASTE_TEXT_FILES;
export type TasteTexts = Record<TasteTextKey, string>;
export type TasteRole = "main" | "sub" | "independent";

/** 文本目录：dev 下是本扩展目录的 texts/，打包后在 chunk 旁。 */
export function tasteTextsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "texts");
}

const cache = new Map<string, TasteTexts>();

export function loadTasteTexts(dir: string = tasteTextsDir()): TasteTexts | undefined {
  const cached = cache.get(dir);
  if (cached) return cached;
  try {
    const entries = Object.entries(TASTE_TEXT_FILES).map(([key, file]) => {
      const text = readFileSync(join(dir, file), "utf8").trim();
      if (!text) throw new Error(`empty text: ${file}`);
      return [key, text] as const;
    });
    const texts = Object.fromEntries(entries) as TasteTexts;
    cache.set(dir, texts);
    return texts;
  } catch (error) {
    console.error("[gpt-with-taste] 读取行为文本失败：", error);
    return undefined;
  }
}

/** 仅测试用：清掉文本缓存。 */
export function __resetTasteTextsForTest(): void {
  cache.clear();
}
