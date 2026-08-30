import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageReport, CallUsage, SessionUsage } from '../../src/lib/usageReport';

export class UsageService {
  constructor(private readonly agentDir: string) {}

  async report(): Promise<UsageReport> {
    const files = await collectJsonl(join(this.agentDir, 'sessions'));
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, sessions: 0, messages: 0, cacheHitRate: 0 };
    const days = new Map<string, { tokens: number; cost: number }>(); const models = new Map<string, { provider: string; model: string; tokens: number; cost: number; messages: number }>();
    const projects = new Map<string, { name: string | null; tokens: number; cost: number; sessions: number }>(); const sessions: SessionUsage[] = []; const calls: CallUsage[] = [];
    for (const path of files) {
      const lines = (await readFile(path, 'utf8')).split(/\r?\n/); const header = parse(lines[0]); if (header?.type !== 'session') continue;
      totals.sessions += 1; let sessionTokens = 0; let sessionCost = 0; let name = text(header.name); let latestName = name;
      for (const line of lines.slice(1)) {
        const entry = parse(line); if (!entry) continue;
        if (entry.type === 'session_info' && text(entry.name)?.trim()) latestName = text(entry.name)!.trim();
        const usage = usageLine(entry); if (!usage) continue;
        totals.input += usage.input; totals.output += usage.output; totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite; totals.totalTokens += usage.totalTokens; totals.cost += usage.cost; totals.messages += 1;
        sessionTokens += usage.totalTokens; sessionCost += usage.cost;
        const timestamp = usage.timestamp ?? text(header.timestamp); const day = (timestamp ?? '').slice(0, 10); if (day) add(days, day, usage.totalTokens, usage.cost);
        const modelKey = `${usage.provider}\0${usage.model}`; const model = models.get(modelKey) ?? { provider: usage.provider, model: usage.model, tokens: 0, cost: 0, messages: 0 }; model.tokens += usage.totalTokens; model.cost += usage.cost; model.messages += 1; models.set(modelKey, model);
        calls.push({ ...usage, timestamp });
      }
      const cwd = text(header.cwd); const id = text(header.id) ?? ''; const timestamp = text(header.timestamp);
      sessions.push({ id, name: latestName, cwd, path, timestamp, tokens: sessionTokens, cost: sessionCost });
      if (cwd) { const project = projects.get(cwd) ?? { name: latestName, tokens: 0, cost: 0, sessions: 0 }; if (!project.name) project.name = latestName; project.tokens += sessionTokens; project.cost += sessionCost; project.sessions += 1; projects.set(cwd, project); }
    }
    totals.cacheHitRate = totals.input + totals.cacheRead ? totals.cacheRead / (totals.input + totals.cacheRead) : 0;
    return { totals, byDay: [...days].map(([date, value]) => ({ date, ...value })).sort((a, b) => a.date.localeCompare(b.date)), byModel: [...models.values()].sort((a, b) => b.tokens - a.tokens), byProject: [...projects].map(([cwd, value]) => ({ cwd, ...value })).sort((a, b) => b.tokens - a.tokens), recentSessions: sessions.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, 50), calls: calls.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, 500) };
  }
}

async function collectJsonl(directory: string): Promise<string[]> { try { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map((entry) => entry.isDirectory() ? collectJsonl(join(directory, entry.name)) : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : []))).flat(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
function parse(line: string): Record<string, unknown> | null { try { const value = JSON.parse(line) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function add(map: Map<string, { tokens: number; cost: number }>, key: string, tokens: number, cost: number): void { const item = map.get(key) ?? { tokens: 0, cost: 0 }; item.tokens += tokens; item.cost += cost; map.set(key, item); }
function usageLine(entry: Record<string, unknown>): Omit<CallUsage, 'timestamp'> & { timestamp: string | null } | null { if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') return null; const message = entry.message as Record<string, unknown>; if (message.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') return null; const usage = message.usage as Record<string, unknown>; const n = (key: string) => typeof usage[key] === 'number' ? usage[key] : 0; const costData = usage.cost && typeof usage.cost === 'object' ? usage.cost as Record<string, unknown> : {}; return { timestamp: text(entry.timestamp), provider: text(message.provider) ?? '', model: text(message.model) ?? '', input: n('input'), output: n('output'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite'), totalTokens: n('totalTokens'), cost: typeof costData.total === 'number' ? costData.total : 0 }; }
