// Normalize spawn_agent params into a uniform { task, model?, agent? }[] list.
export interface NormalizedTask {
  task: string;
  model?: string;
  agent?: string;
}

export type TaskInput = string | { task: string; model?: string; agent?: string };

export interface SpawnParams {
  task?: string;
  model?: string;
  agent?: string;
  tasks?: TaskInput[];
}

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
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
