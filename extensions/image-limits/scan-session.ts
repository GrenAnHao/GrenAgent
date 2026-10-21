// 手动验证用：把一个真实会话 JSONL 的消息喂给 image-limits 的 context 钩子，
// 打印修正前后超限图片的数量和尺寸。用法：npx tsx image-limits/scan-session.ts <session.jsonl>
import { readFileSync } from "node:fs";
import imageLimits from "./index.js";
import { DEFAULT_IMAGE_LIMITS, isImageBlock, readImageSize } from "./limits.js";

type Msg = { role?: string; content?: unknown };

function oversized(messages: Msg[]): string[] {
  const out: string[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    for (const block of m.content) {
      if (!isImageBlock(block)) continue;
      const size = readImageSize(block.data);
      if (!size) continue;
      if (size.width > DEFAULT_IMAGE_LIMITS.maxWidth || size.height > DEFAULT_IMAGE_LIMITS.maxHeight) {
        out.push(`#${i} ${m.role} ${size.width}x${size.height}`);
      }
    }
  });
  return out;
}

const file = process.argv[2];
if (!file) throw new Error("usage: scan-session.ts <session.jsonl>");
const messages: Msg[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { type?: string; message?: Msg })
  .filter((e) => e.type === "message" && e.message)
  .map((e) => e.message!);

const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<{ messages?: Msg[] } | undefined>>();
imageLimits({ on: (name: string, fn: never) => handlers.set(name, fn) } as never);

const before = oversized(messages);
const images = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(isImageBlock).length : 0), 0);
console.log(`messages=${messages.length} images=${images} oversized before=${before.length}`);
for (const line of before) console.log(`  ${line}`);

const t0 = Date.now();
const first = await handlers.get("context")!({ type: "context", messages }, { model: undefined });
const t1 = Date.now();
await handlers.get("context")!({ type: "context", messages }, { model: undefined });
const t2 = Date.now();
const after = oversized(first?.messages ?? messages);
console.log(`oversized after=${after.length} first pass ${t1 - t0}ms, cached pass ${t2 - t1}ms`);
for (const line of after) console.log(`  ${line}`);
if (after.length > 0) process.exit(1);
