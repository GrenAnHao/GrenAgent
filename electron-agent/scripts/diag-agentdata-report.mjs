#!/usr/bin/env node
// 读 runtime-diag.jsonl，回答「主进程卡顿里 AgentData 占多少」，并按 M0 闸门给出结论。
// 见 .agents/notes/implemented/process/2026-10-16-agentdata-sync-timing-diag.md。
// 只读主进程的 sample：AgentData 默认跑在 agentdata-host 子进程里之后，只有 GREN_AGENTDATA_PROCESS=inproc 的日志才有可比数据，
// 见 .agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md。
//
//   node scripts/diag-agentdata-report.mjs [--dir <logs 目录>] [--since <ISO 时间>] [--json]
//
// 默认目录依次尝试 userData 下的 electron-agent/logs（开发）与 GrenAgent/logs（安装包）。
// 默认起点是第一条带 agentData 字段的采样（埋点上线之前的窗口没有可比数据）。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STALL_MS = 200;
const SLOW_SEGMENT_MS = 100;
const BIG_SEGMENT_MS = 200;
const MIN_ACTIVE_WINDOWS = 360; // 约 1 小时有 Agent 活动
const MIN_STALL_WINDOWS = 10;
const SHARE_THRESHOLD = 0.2;
const BIG_PER_ACTIVE_HOUR = 1;

function args(argv) {
  const out = { dir: undefined, since: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--since') out.since = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

function userDataRoots() {
  if (process.platform === 'win32') return [process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')];
  if (process.platform === 'darwin') return [join(homedir(), 'Library', 'Application Support')];
  return [process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')];
}

function defaultDirs() {
  return userDataRoots().flatMap((root) => ['electron-agent', 'GrenAgent'].map((name) => join(root, name, 'logs')))
    .filter((dir) => existsSync(join(dir, 'runtime-diag.jsonl')));
}

function readSamples(dir) {
  const rows = [];
  for (const name of ['runtime-diag.jsonl.1', 'runtime-diag.jsonl']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record.kind === 'sample' && record.lag) rows.push(record);
      } catch { /* 截断的行 */ }
    }
  }
  return rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const eventCount = (row) => Object.values(row.events ?? {}).reduce((sum, n) => sum + Number(n || 0), 0);
const topLevelSlow = (row) => (row.agentData?.slow ?? []).filter((segment) => !segment.nested);

export function report(rows, since) {
  const start = since ?? rows.find((row) => row.agentData)?.t;
  if (!start) return { instrumented: false, verdict: 'NO_DATA', reason: '日志里还没有带 agentData 字段的采样（埋点版本尚未运行过）' };
  const windows = rows.filter((row) => row.t >= start);
  const active = windows.filter((row) => eventCount(row) > 0);
  const stalls = windows.filter((row) => row.lag.maxMs >= STALL_MS);
  const attributed = stalls.filter((row) => topLevelSlow(row).some((segment) => segment.syncMs >= SLOW_SEGMENT_MS));
  const big = windows.flatMap((row) => topLevelSlow(row).filter((segment) => segment.syncMs >= BIG_SEGMENT_MS).map((segment) => ({ t: row.t, ...segment })));
  const activeSync = active.map((row) => row.agentData?.syncMs ?? 0);

  const methods = new Map();
  for (const row of windows) {
    for (const entry of row.agentData?.methods ?? []) {
      const stat = methods.get(entry.method) ?? { n: 0, syncMs: 0, syncMaxMs: 0 };
      stat.n += entry.n; stat.syncMs += entry.syncMs; stat.syncMaxMs = Math.max(stat.syncMaxMs, entry.syncMaxMs);
      methods.set(entry.method, stat);
    }
  }
  const topMethods = [...methods.entries()].map(([method, s]) => ({ method, ...s, syncMs: Math.round(s.syncMs) }))
    .sort((a, b) => b.syncMs - a.syncMs).slice(0, 15);

  const share = stalls.length ? attributed.length / stalls.length : 0;
  const activeHours = active.length / 360;
  const bigPerActiveHour = activeHours ? big.length / activeHours : 0;
  let verdict; let reason;
  if (active.length < MIN_ACTIVE_WINDOWS) {
    verdict = 'INSUFFICIENT';
    reason = `有 Agent 活动的窗口只有 ${active.length} 个，至少需要 ${MIN_ACTIVE_WINDOWS} 个（约 1 小时活跃）`;
  } else if (stalls.length >= MIN_STALL_WINDOWS && share >= SHARE_THRESHOLD) {
    verdict = 'CONTINUE';
    reason = `${(share * 100).toFixed(1)}% 的卡顿窗口（≥${STALL_MS}ms）里有 ≥${SLOW_SEGMENT_MS}ms 的 AgentData 同步段，达到 ${SHARE_THRESHOLD * 100}% 的门槛`;
  } else if (bigPerActiveHour >= BIG_PER_ACTIVE_HOUR) {
    verdict = 'CONTINUE';
    reason = `≥${BIG_SEGMENT_MS}ms 的 AgentData 同步段平均每活跃小时 ${bigPerActiveHour.toFixed(2)} 次，达到 ${BIG_PER_ACTIVE_HOUR} 次的门槛`;
  } else {
    verdict = 'STOP';
    reason = `卡顿窗口中 AgentData 占比 ${(share * 100).toFixed(1)}%（门槛 ${SHARE_THRESHOLD * 100}%），≥${BIG_SEGMENT_MS}ms 同步段每活跃小时 ${bigPerActiveHour.toFixed(2)} 次（门槛 ${BIG_PER_ACTIVE_HOUR}）；停在 M0，按方法榜做局部修复`;
  }
  return {
    instrumented: true, since: start, until: windows.at(-1)?.t,
    windows: windows.length, activeWindows: active.length, stallWindows: stalls.length,
    stallWindowsWithAgentData: attributed.length, share: Number(share.toFixed(3)),
    activeAgentDataSyncMs: { p50: percentile(activeSync, 0.5), p95: percentile(activeSync, 0.95), max: Math.max(0, ...activeSync) },
    bigSegments: big.length, bigPerActiveHour: Number(bigPerActiveHour.toFixed(2)),
    topMethods, slowest: big.sort((a, b) => b.syncMs - a.syncMs).slice(0, 10),
    verdict, reason,
  };
}

function main() {
  const options = args(process.argv.slice(2));
  const dirs = options.dir ? [options.dir] : defaultDirs();
  if (!dirs.length) {
    console.error('找不到 runtime-diag.jsonl，请用 --dir 指定 logs 目录');
    process.exit(2);
  }
  for (const dir of dirs) {
    const result = report(readSamples(dir), options.since);
    if (options.json) { console.log(JSON.stringify({ dir, ...result }, null, 2)); continue; }
    console.log(`\n# ${dir}`);
    if (!result.instrumented) { console.log(`结论: ${result.verdict} — ${result.reason}`); continue; }
    console.log(`区间 ${result.since} → ${result.until}；窗口 ${result.windows}，有活动 ${result.activeWindows}，卡顿(≥${STALL_MS}ms) ${result.stallWindows}`);
    console.log(`卡顿窗口里有 ≥${SLOW_SEGMENT_MS}ms AgentData 同步段: ${result.stallWindowsWithAgentData}（${(result.share * 100).toFixed(1)}%）`);
    console.log(`有活动窗口的 AgentData 同步合计 p50/p95/max: ${result.activeAgentDataSyncMs.p50}/${result.activeAgentDataSyncMs.p95}/${result.activeAgentDataSyncMs.max} ms`);
    console.log(`≥${BIG_SEGMENT_MS}ms 同步段: ${result.bigSegments} 次，每活跃小时 ${result.bigPerActiveHour}`);
    console.log('方法榜（同步耗时合计）:');
    for (const row of result.topMethods) console.log(`  ${row.method.padEnd(36)} n ${String(row.n).padStart(6)}  sync ${String(row.syncMs).padStart(8)} ms  max ${row.syncMaxMs} ms`);
    if (result.slowest.length) console.log('最慢的同步段:');
    for (const row of result.slowest) console.log(`  ${row.t}  ${row.method}  ${row.syncMs} ms`);
    console.log(`结论: ${result.verdict} — ${result.reason}`);
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/diag-agentdata-report.mjs')) main();
