// Normalize spawn_agent params into a uniform { task, model?, agent? }[] list.
export interface NormalizedTask {
  task: string;
  model?: string;
  agent?: string;
  /** 卡片上的短任务名。不进入子代理正文。 */
  title?: string;
}

export type TaskInput = string | { task: string; model?: string; agent?: string };

export interface SpawnParams {
  task?: string;
  model?: string;
  agent?: string;
  tasks?: TaskInput[];
  chain?: Array<{ task?: string }>;
}

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

/**
 * 从尚未写完的 spawn_agent 参数里取出已经闭合的 `tasks` 项。
 * 只认原始文本里真正结束的字符串或对象，不用流式解析器自动补上的引号。
 */
export function closedParallelTasks(raw: string): NormalizedTask[] {
  return closedTaskArray(raw, "tasks");
}

/** 链式步骤。对象没闭合前不取出，避免半截 title / task 进卡片。 */
export function closedChainSteps(raw: string): NormalizedTask[] {
  return closedTaskArray(raw, "chain");
}

function closedTaskArray(raw: string, key: string): NormalizedTask[] {
  const start = arrayContent(raw, key);
  if (start < 0) return [];
  const out: NormalizedTask[] = [];
  let i = start;
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i]!)) i++;
    if (i >= raw.length || raw[i] === "]") break;
    if (raw[i] === '"') {
      const parsed = readJsonString(raw, i);
      if (!parsed) break;
      const task = clean(parsed.value);
      if (task) out.push({ task });
      i = parsed.end;
      continue;
    }
    if (raw[i] === "{") {
      const parsed = readJsonObject(raw, i);
      if (!parsed) break;
      try {
        const obj = JSON.parse(parsed.slice) as { task?: unknown; model?: unknown; agent?: unknown; title?: unknown };
        const task = typeof obj.task === "string" ? clean(obj.task) : undefined;
        const title = typeof obj.title === "string" ? clean(obj.title) : undefined;
        if (task) {
          out.push({
            task,
            model: typeof obj.model === "string" ? clean(obj.model) : undefined,
            agent: typeof obj.agent === "string" ? clean(obj.agent) : undefined,
            ...(title ? { title } : {}),
          });
        }
      } catch {
        break;
      }
      i = parsed.end;
      continue;
    }
    break;
  }
  return out;
}

function arrayContent(raw: string, key: string): number {
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      i++;
      continue;
    }
    const parsed = readJsonString(raw, i);
    if (!parsed) return -1;
    if (parsed.value === key) {
      let j = parsed.end;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] !== ":") {
        i = parsed.end;
        continue;
      }
      j++;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === "[") return j + 1;
    }
    i = parsed.end;
  }
  return -1;
}

function readJsonString(raw: string, i: number): { value: string; end: number } | null {
  if (raw[i] !== '"') return null;
  let j = i + 1;
  let value = "";
  while (j < raw.length) {
    const c = raw[j]!;
    if (c === "\\") {
      if (j + 1 >= raw.length) return null;
      const n = raw[j + 1]!;
      value += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
      j += 2;
      continue;
    }
    if (c === '"') return { value, end: j + 1 };
    value += c;
    j++;
  }
  return null;
}

function readJsonObject(raw: string, i: number): { slice: string; end: number } | null {
  if (raw[i] !== "{") return null;
  let depth = 0;
  let j = i;
  let inStr = false;
  let esc = false;
  while (j < raw.length) {
    const c = raw[j]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      j++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { slice: raw.slice(i, j + 1), end: j + 1 };
    }
    j++;
  }
  return null;
}

/** 顶层字符串字段。未出现为 undefined；键在但值还没闭合为 null。 */
export function closedStringField(raw: string, key: string): string | undefined | null {
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      i++;
      continue;
    }
    const parsed = readJsonString(raw, i);
    if (!parsed) return null;
    if (parsed.value !== key) {
      i = parsed.end;
      continue;
    }
    let j = parsed.end;
    while (j < raw.length && /\s/.test(raw[j]!)) j++;
    if (raw[j] !== ":") {
      i = parsed.end;
      continue;
    }
    j++;
    while (j < raw.length && /\s/.test(raw[j]!)) j++;
    if (j >= raw.length || raw[j] !== '"') return null;
    const value = readJsonString(raw, j);
    if (!value) return null;
    return value.value;
  }
  return undefined;
}

/**
 * 只认根对象上的字符串字段。嵌套的同名键（并行项里的 title）不算。
 * 未出现为 undefined；键在但值还没闭合为 null。
 */
export function closedTopLevelString(raw: string, key: string): string | undefined | null {
  let depth = 0;
  let i = 0;
  let expectKey = false;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      const parsed = readJsonString(raw, i);
      if (!parsed) return null;
      if (depth === 1 && expectKey && parsed.value === key) {
        let j = parsed.end;
        while (j < raw.length && /\s/.test(raw[j]!)) j++;
        if (raw[j] !== ":") return null;
        j++;
        while (j < raw.length && /\s/.test(raw[j]!)) j++;
        if (j >= raw.length || raw[j] !== '"') return null;
        const value = readJsonString(raw, j);
        if (!value) return null;
        return value.value;
      }
      if (depth === 1 && expectKey) expectKey = false;
      i = parsed.end;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (c === "{" && depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && c === ",") expectKey = true;
    i++;
  }
  return undefined;
}

export function normalizeTasks(params: SpawnParams): NormalizedTask[] {
  const out: NormalizedTask[] = [];
  const single = clean(params.task);
  if (single) out.push({ task: single, model: clean(params.model), agent: clean(params.agent) });
  for (const t of params.tasks ?? []) {
    if (typeof t === "string") {
      const task = clean(t);
      if (task) out.push({ task, agent: clean(params.agent) });
    } else if (t && typeof t.task === "string") {
      const task = clean(t.task);
      if (task) out.push({ task, model: clean(t.model), agent: clean(t.agent) ?? clean(params.agent) });
    }
  }
  return out;
}

/**
 * Whether the call carries any runnable work. `chain` is a valid standalone mode
 * (sequential steps with {previous}) and must NOT require `task`/`tasks` — the
 * guard that uses this is what previously rejected chain-only calls with
 * "provide task or tasks".
 */
export function spawnHasWork(params: SpawnParams): boolean {
  return normalizeTasks(params).length > 0 || (params.chain?.length ?? 0) > 0;
}
