// 用真实会话的首条用户消息、真实模型，对比旧提示词（2026-10-04 版，首条消息原文）和新链路（拆包装 + 新提示词 + 输出清洗）。
// 用法：复制到 extensions/auto-title/.title-eval.mts（import 改成 ../_shared/、./），在 extensions 目录 npx tsx auto-title/.title-eval.mts <provider/model> [条数]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fallbackSessionTitle, firstUserMessage, titleModelInput } from "../../../extensions/_shared/session-title.js";
import { summarize } from "../../../extensions/_shared/summarize.js";
import { chainSummaryTitle, cleanGeneratedTitle, TITLE_MAX_TOKENS } from "../../../extensions/auto-title/title.js";

const agentDir = join(homedir(), ".pi", "agent");
const [provider, id] = (process.argv[2] ?? "newapi-local/glm-5.3-flash").split("/");
const limit = Number(process.argv[3] ?? 40);

function oldPrompt(instruction: string): { system: string; user: string } {
  const head = "<task>\nGenerate a concise title that captures the essence of the conversation.\n</task>\n\n<conversation>\n<user>\n";
  const tail = "\n</user>\n</conversation>";
  const body = instruction.trim().slice(0, Math.max(0, 4000 - head.length - tail.length));
  return {
    system: `You are a professional conversation summarizer. Generate a concise title that captures the essence of the conversation.

Rules:
- Reply with only the title
- No explanations
- Maximum 15 words
- Maximum 80 characters
- No punctuation marks
- Use the language specified by the locale code: zh-CN
- The title should accurately reflect the main topic of the conversation
- Keep it short and to the point`,
    user: `${head}${body}${tail}`,
  };
}

/** 旧链路落盘前只做 cleanLine（取首行、去引号、截 80）。 */
function oldClean(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return [...line.replace(/^["'“”「『]+/, "").replace(/["'“”」』]+$/, "").trim()].slice(0, 80).join("");
}

type Sample = { file: string; text: string; images: number };
const samples: Sample[] = [];
const root = join(agentDir, "sessions");
for (const dir of readdirSync(root)) {
  let files: string[];
  try { files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
  for (const f of files) {
    const raw = readFileSync(join(root, dir, f), "utf8");
    if (raw.includes('"subagent_meta"') || raw.includes("Extract durable memory") || raw.includes("\\nTask kind: ")) continue;
    const entries = raw.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const first = firstUserMessage(entries);
    if (first) samples.push({ file: f, ...first });
  }
}
samples.sort((a, b) => (a.file < b.file ? 1 : -1));
const wrapped = samples.filter((s) => /^\s*<|\[Image/.test(s.text) || s.images > 0);
const picked = [...new Map([...samples.slice(0, limit), ...wrapped].map((s) => [s.file, s])).values()];

const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
const registry = new ModelRegistry(runtime);
const model = registry.find(provider, id);
if (!model) throw new Error(`model not found: ${provider}/${id}`);
const ctx = { model, modelRegistry: registry } as never;

async function call(system: string, user: string, maxTokens = TITLE_MAX_TOKENS): Promise<string> {
  try {
    return await summarize(ctx, user, { systemPrompt: system, maxTokens, raw: true });
  } catch (err) {
    return `!error ${err instanceof Error ? err.message : String(err)}`;
  }
}

console.log(`# 标题对比：${provider}/${id}，${picked.length} 条首条消息\n`);
console.log("| 首条消息（前 60 字） | 旧兜底 | 新兜底 | 旧标题 | 新标题 | 新模型原文 |");
console.log("|---|---|---|---|---|---|");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
let oldBad = 0;
let newEmpty = 0;
for (const sample of picked) {
  const old = oldPrompt(sample.text);
  // 旧链路按当时的 64 token 上限跑，反映用户以前实际拿到的标题。
  const oldTitle = oldClean(await call(old.system, old.user, 64));
  const input = titleModelInput(sample.text, sample.images);
  let newRaw = "";
  let newTitle = "";
  if (input) {
    const next = chainSummaryTitle(input, "zh-CN");
    newRaw = await call(next.system, next.user);
    newTitle = cleanGeneratedTitle(newRaw);
  }
  if (!newTitle) newEmpty += 1;
  if (/^[#*{]|无法|当前环境|^\s*$/.test(oldTitle) || [...oldTitle].length > 30) oldBad += 1;
  const oldFallback = sample.text.replace(/\s+/g, " ").trim().slice(0, 80);
  const newFallback = fallbackSessionTitle(sample.text, sample.images) ?? "（时间标题）";
  console.log(`| ${esc([...sample.text.replace(/\s+/g, " ").trim()].slice(0, 60).join(""))} | ${esc([...oldFallback].slice(0, 30).join(""))} | ${esc(newFallback.slice(0, 40))} | ${esc(oldTitle)} | ${esc(newTitle || "（不写，显示兜底）")} | ${esc(newRaw.slice(0, 60))} |`);
}
console.log(`\n旧标题明显不合格（以 # * { 开头、含「无法」「当前环境」、空、超过 30 字）：${oldBad} / ${picked.length}`);
console.log(`新链路没写标题（清洗后为空或只有图片）：${newEmpty} / ${picked.length}`);
// ModelRuntime 持有连接，不主动退出的话 node 会一直挂着。
process.exit(0);
