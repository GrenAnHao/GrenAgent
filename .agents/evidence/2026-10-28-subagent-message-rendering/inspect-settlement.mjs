import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const target = process.argv[2] || 'sa-1d7293f9';
const root = join(homedir(), '.pi', 'agent', 'sessions');
const paths = (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.jsonl'));
const recent = [];
for (const name of paths) {
  const path = join(root, name);
  const info = await stat(path);
  if (info.mtimeMs > Date.now() - 3 * 86400_000) recent.push({ path, time: info.mtimeMs });
}
recent.sort((a, b) => b.time - a.time);
let matches = 0;
for (const { path } of recent) {
  let number = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    number++;
    if (!line.includes(target)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.message ?? (entry.type === 'custom_message' ? { ...entry, role: 'custom' } : undefined);
    if (message?.role === 'custom' && message.customType === 'subagent-settled' && (message.details?.childId === target || String(message.content).startsWith(`Background subagent ${target} `))) {
      console.log(JSON.stringify({ path, line: number, entryId: entry.id, timestamp: entry.timestamp, customType: message.customType, details: message.details, summary: String(message.content).split('\n')[0], closingCharacters: String(message.content).length }));
      matches++;
    } else if (message?.role === 'assistant' && Array.isArray(message.content)) {
      const calls = message.content.filter((part) => part.type === 'toolCall' && JSON.stringify(part.arguments ?? {}).includes(target));
      for (const call of calls) {
        console.log(JSON.stringify({ path, line: number, toolName: call.name, action: call.arguments?.action, agentId: call.arguments?.agentId ?? call.arguments?.agent_id, messagePreview: typeof call.arguments?.message === 'string' ? call.arguments.message.slice(0, 140) : undefined }));
        matches++;
      }
    } else if (entry.type === 'custom' && entry.customType?.includes('subagent')) {
      console.log(JSON.stringify({ path, line: number, type: entry.type, customType: entry.customType, data: entry.data }));
      matches++;
    } else if (message?.role === 'toolResult') {
      console.log(JSON.stringify({ path, line: number, toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError, details: message.details && Object.fromEntries(Object.entries(message.details).filter(([key]) => ['agentId','status','stopReason','sessionPath','stopped','agent_id'].includes(key))), firstLine: String(message.content?.find?.((part) => part.type === 'text')?.text ?? '').split('\n')[0] }));
      matches++;
    }
  }
}
console.log(JSON.stringify({ scannedFiles: recent.length, matches }));
