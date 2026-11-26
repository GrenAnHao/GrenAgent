import { posix, win32 } from "node:path";
import type { DatabaseSync } from "../_shared/sqlite.js";
import { CALL_PAGE_SIZE, type CallQuery, type CallPage, cleanUsageTitle, standardUsageModel, type CostSource, type DayUsage, type ModelUsage, type ProjectUsage, type SessionUsage, type UsageFilters, type UsageProject, type UsageReport, type WarmUsage } from "./analytics.js";

type Project = UsageProject & { cwd: string };
const globalProject: Project = { projectId: "global", name: "未归属会话 (全局对话)", cwd: "" };
const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const hitRate = (input: number, hits: number) => input + hits > 0 ? hits / (input + hits) : 0;
const sourceOf = (value: unknown): CostSource => value === "provider" || value === "catalog" ? value : "unknown";

function pathKey(raw: string) {
  const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(raw);
  if (windows) {
    const path = raw.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    return win32.normalize(path).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  }
  return posix.isAbsolute(raw) ? posix.normalize(raw).replace(/\/$/, "") || "/" : "";
}

function projectFor(cwd: string | null, worksKeys: string[]): Project {
  if (!cwd?.trim()) return globalProject;
  const key = pathKey(cwd);
  if (!key || worksKeys.some(root => key === root || key.startsWith(root + "/"))) return globalProject;
  const filePath = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd) ? win32 : posix;
  return { projectId: "cwd:" + key, name: cleanUsageTitle(filePath.basename(filePath.normalize(cwd))) || key, cwd };
}

interface Session { id: string; cwd: string | null; path: string | null; name: string | null; started_at: string | null }
interface Rollup { day: string; session_id: string; provider: string; model: string; input: number; output: number; cache_read: number; cache_write: number; total_tokens: number; cost: number; messages: number }
interface WarmGroup { day: string; session_id: string; provider: string; model: string; source: string; tokens: number; cost: number; messages: number }

function reportScope(db: DatabaseSync, filters: UsageFilters, worksDir: string | string[], now: Date) {
  const sessions = db.prepare(`
    SELECT ids.id, s.cwd, s.path, s.name, s.started_at
    FROM (SELECT DISTINCT session_id AS id FROM rollup UNION SELECT DISTINCT session_id FROM aux_usage) ids
    LEFT JOIN sessions s ON s.id = ids.id ORDER BY ids.id`).all() as Session[];
  const metadata = new Map<string, Session>();
  const projectIndex = new Map<string, Project>();
  const sessionProjects = new Map<string, Project>();
  const worksKeys = [...new Set((Array.isArray(worksDir) ? worksDir : [worksDir]).map(pathKey).filter(Boolean))];
  for (const session of sessions) {
    const project = projectFor(session.cwd, worksKeys);
    metadata.set(session.id, session);
    if (!projectIndex.has(project.projectId)) projectIndex.set(project.projectId, project);
    sessionProjects.set(session.id, projectIndex.get(project.projectId)!);
  }
  const nameCounts = new Map<string, number>();
  for (const {name} of projectIndex.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  // Identical basenames remain separate projects. Make them distinguishable even in a closed select.
  for (const p of projectIndex.values()) if (p.cwd && nameCounts.get(p.name)! > 1) p.name = p.cwd;
  const projects = [...projectIndex.values()].map(({ projectId, name }) => ({ projectId, name }))
    .sort((a, b) => a.projectId === "global" ? 1 : b.projectId === "global" ? -1 : a.name.localeCompare(b.name));

  const days = filters.range === "7d" ? 7 : filters.range === "30d" ? 30 : 0;
  // SQLite owns the calendar conversion for both the period and the observations (including DST).
  const calendar = days ? db.prepare(`WITH RECURSIVE dates(day,n) AS (
    SELECT date(?, 'localtime', ?), 1 UNION ALL SELECT date(day,'+1 day'), n+1 FROM dates WHERE n < ?
  ) SELECT day FROM dates ORDER BY day`).all(now.toISOString(), `-${days - 1} days`, days) as {day:string}[] : [];
  const where: string[] = [];
  const params: string[] = [];
  if (filters.projectId !== undefined) {
    const ids = sessions.filter(s => sessionProjects.get(s.id)?.projectId === filters.projectId).map(s => s.id);
    where.push("session_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(ids));
  }
  if (days) params.push(calendar[0].day, calendar[days - 1].day);
  const scope = (extra: string[] = []) => {
    const terms = days ? [...where, "date(ts,'localtime') BETWEEN ? AND ?", ...extra] : [...where, ...extra];
    return terms.length ? " WHERE " + terms.join(" AND ") : "";
  };
  return { projects, sessionProjects, metadata, scope, params, calendar };
}
const callColumns = `ts AS timestamp, provider, model, response_model AS responseModel, COALESCE(cost_source,'unknown') AS costSource,
  input, output, cache_read AS cacheRead, cache_write AS cacheWrite, total_tokens AS totalTokens, cost`;
export function readCallPage(db: DatabaseSync, query: CallQuery, worksDir: string | string[], now: Date): CallPage {
  const {scope, params} = reportScope(db, query, worksDir, now);
  const groups = db.prepare("SELECT provider, model, COUNT(*) AS n FROM calls" + scope() + " GROUP BY provider,model")
    .all(...params) as {provider:string; model:string; n:number}[];
  const total = groups.filter(g=>(!query.provider || g.provider===query.provider) && (!query.model || g.model===query.model)).reduce((s,g)=>s+g.n,0);
  const page = Math.min(query.page, Math.max(1, Math.ceil(total / CALL_PAGE_SIZE)));
  const terms:string[] = [], values = [...params];
  if (query.provider) { terms.push('provider = ?'); values.push(query.provider); }
  if (query.model) { terms.push('model = ?'); values.push(query.model); }
  const rows = db.prepare('SELECT ' + callColumns + ' FROM calls' + scope(terms) + ' ORDER BY ts DESC,key LIMIT ? OFFSET ?')
    .all(...values, CALL_PAGE_SIZE, (page - 1) * CALL_PAGE_SIZE) as CallPage['rows'];
  return {rows,total,page,providers:[...new Set(groups.map(g=>g.provider))].sort(),models:[...new Set(groups.map(g=>g.model))].sort()};
}
/** A read snapshot of the existing ledger; no rewrite, repricing or new ingestion of historical calls. */
export function readUsageReport(db: DatabaseSync, filters: UsageFilters, worksDir: string | string[], now: Date): Required<UsageReport> {
  const { projects, sessionProjects, metadata, scope, params, calendar } = reportScope(db, filters, worksDir, now);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, sessions: 0, messages: 0, cacheHitRate: 0 };
  const dayMap = new Map<string, DayUsage & { input: number; hits: number }>();
  const modelMap = new Map<string, ModelUsage & { providers: Set<string> }>();
  const projectMap = new Map<string, ProjectUsage & { ids: Set<string> }>();
  const recent = new Map<string, { tokens: number; cost: number }>();

  function dayOf(date: string) {
    let row = dayMap.get(date);
    if (!row) { row = { date, tokens: 0, cost: 0, recordedCost: 0, messages: 0, cacheHitRate: 0, input: 0, hits: 0 }; dayMap.set(date, row); }
    return row;
  }
  function dimensions(sessionId: string, provider: string, rawModel: string, date: string, cost: number) {
    const model = standardUsageModel(provider, rawModel);
    let m = modelMap.get(model);
    if (!m) { m = { model, provider: "", providers: new Set<string>(), messages: 0, tokens: 0, cost: 0, recordedCost: 0 }; modelMap.set(model, m); }
    if (provider.trim()) m.providers.add(provider.trim());
    const identity = sessionProjects.get(sessionId) ?? globalProject;
    let p = projectMap.get(identity.projectId);
    if (!p) { p = { ...identity, tokens: 0, cost: 0, recordedCost: 0, sessions: 0, ids: new Set<string>() }; projectMap.set(p.projectId, p); }
    const d = date ? dayOf(date) : undefined;
    if (d) d.recordedCost += cost;
    m.recordedCost += cost;
    p.recordedCost += cost;
    return { m, p, d };
  }
  for (const {day} of calendar) dayOf(day);
  for (const r of db.prepare(`SELECT date(ts,'localtime') AS day, session_id, provider, model, SUM(input) AS input, SUM(output) AS output,
    SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(total_tokens) AS total_tokens,
    SUM(cost) AS cost, COUNT(*) AS messages FROM calls` + scope() + " GROUP BY day, session_id, provider, model").all(...params) as Rollup[]) {
    const { m, p, d } = dimensions(r.session_id, r.provider, r.model, r.day, r.cost);
    if (d) { d.tokens += r.total_tokens; d.cost += r.cost; d.messages += r.messages; d.input += r.input; d.hits += r.cache_read; }
    m.tokens += r.total_tokens; m.cost += r.cost; m.messages += r.messages;
    p.tokens += r.total_tokens; p.cost += r.cost; p.ids.add(r.session_id);
    const s = recent.get(r.session_id) ?? { tokens: 0, cost: 0 };
    s.tokens += r.total_tokens; s.cost += r.cost; recent.set(r.session_id, s);
    totals.input += r.input; totals.output += r.output; totals.cacheRead += r.cache_read; totals.cacheWrite += r.cache_write;
    totals.totalTokens += r.total_tokens; totals.cost += r.cost; totals.messages += r.messages;
  }
  totals.sessions = recent.size;
  totals.cacheHitRate = hitRate(totals.input, totals.cacheRead);

  const sourceBreakdown: Record<CostSource, number> = { provider: 0, catalog: 0, unknown: 0 };
  for (const r of db.prepare("SELECT cost_source AS source, SUM(cost) AS cost FROM calls" + scope() + " GROUP BY cost_source").all(...params) as {source: string; cost: number}[]) {
    sourceBreakdown[sourceOf(r.source)] += r.cost;
  }
  const warmingTotals = { cost: 0, messages: 0, totalTokens: 0 };
  const warmSummary = `SELECT date(ts,'localtime') AS day, session_id, provider, attributed_model AS model, cost_source AS source,
    SUM(total_tokens) AS tokens, SUM(cost) AS cost, COUNT(*) AS messages FROM aux_usage` + scope() +
    " GROUP BY day, session_id, provider, attributed_model, cost_source";
  for (const w of db.prepare(warmSummary).all(...params) as WarmGroup[]) {
    dimensions(w.session_id, w.provider, w.model, w.day, w.cost);
    warmingTotals.cost += w.cost; warmingTotals.totalTokens += w.tokens; warmingTotals.messages += w.messages;
    sourceBreakdown[sourceOf(w.source)] += w.cost;
  }
  const recordedCost = { assistantCost: totals.cost, warmingCost: warmingTotals.cost, totalCost: totals.cost + warmingTotals.cost, sourceBreakdown };
  const byDay = [...dayMap.values()].map(({ input, hits, ...d }) => ({ ...d, cacheHitRate: hitRate(input, hits) })).sort((a, b) => byId(a.date, b.date));
  const byModel = [...modelMap.values()].map(({ providers, ...m }) => ({ ...m, provider: [...providers].sort().join(", ") }))
    .sort((a, b) => b.tokens - a.tokens || byId(a.model, b.model));
  const byProject = [...projectMap.values()].map(({ ids, ...p }) => ({ ...p, sessions: ids.size }))
    .sort((a, b) => b.tokens - a.tokens || byId(a.projectId, b.projectId));
  const recentSessions: SessionUsage[] = [];
  for (const [id, usage] of recent) {
    const s = metadata.get(id);
    if (s?.path) recentSessions.push({ id, path: s.path, name: cleanUsageTitle(s.name), cwd: s.cwd, timestamp: s.started_at, ...usage,
      ...(filters.includeAllSessions ? { projectId: (sessionProjects.get(id) ?? globalProject).projectId } : {}) });
  }
  recentSessions.sort((a, b) => byId(b.timestamp ?? "", a.timestamp ?? "") || byId(a.id, b.id));
  const calls = db.prepare("SELECT " + callColumns + " FROM calls" +
    scope() + " ORDER BY ts DESC,key LIMIT 500").all(...params) as UsageReport["calls"];
  const warmingCalls = db.prepare(`SELECT session_id AS sessionId, entry_id AS entryId, ts AS timestamp, kind, provider, attributed_model AS attributedModel,
    input, output, cache_read AS cacheRead, cache_write AS cacheWrite, total_tokens AS totalTokens, cost, cost_source AS costSource FROM aux_usage` +
    scope() + " ORDER BY ts DESC LIMIT 500").all(...params) as WarmUsage[];
  return { projects, totals, byDay, byModel, byProject, recentSessions: filters.includeAllSessions ? recentSessions : recentSessions.slice(0, 50), calls, warmingTotals, warmingCalls, recordedCost };
}
