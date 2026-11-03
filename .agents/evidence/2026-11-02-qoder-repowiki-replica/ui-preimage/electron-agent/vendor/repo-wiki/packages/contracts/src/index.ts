/** Public, renderer-safe contract. No Node/Electron/runtime imports. */
import type { KnowledgeIntent, RepoWikiKnowledgeSnapshot } from '../../../../../shared/knowledgeKernelContracts';
export const PROTOCOL_VERSION = 1 as const;
export const PROGRESS_EVENT = "repoWiki://progress" as const;
export const ACTIONS = [
  "health",
  "projects",
  "create",
  "clone",
  "project",
  "changes",
  "scan",
  "generate",
  "knowledge",
  "action",
  "drafts",
  "run",
  "cancel",
  "page",
  "edit",
  "resolve",
  "plan",
  "watch",
  "source",
  "export",
  "import",
] as const;
export type Action = (typeof ACTIONS)[number];
export type ProviderMode = "demo" | "real";
export type ContentTarget = "wiki" | "cards";
export type SourceRef = {
  path: string;
  start_line: number;
  end_line: number;
  hash?: string;
};
export interface WikiPage {
  id: string;
  title: string;
  markdown: string;
  baseline: string;
  pending_markdown: string | null;
  status: "ready" | "edited" | "conflict" | "archived";
  revision: number;
  storage_token?: string;
  sources: SourceRef[];
  dependencies: string[];
  kind?: "wiki" | "card";
  category?: string;
  summary?: string;
  [key: string]: unknown;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  language: string;
  watch: boolean;
  plan_storage_token?: string;
  pages?: WikiPage[];
  cards?: WikiPage[];
  page_count?: number;
  card_count?: number;
  knowledge?: Record<
    ContentTarget,
    {
      count: number;
      identity: Record<string, unknown>;
      last_run: Record<string, unknown> | null;
      updated_at: string | null;
      namespace: string;
      status: string;
    }
  >;
  runs_by_kind?: Record<ContentTarget, Run>;
  [key: string]: unknown;
}
export interface Run {
  id?: string;
  status: string;
  provider?: string;
  target?: ContentTarget;
  cancelable?: boolean;
  stage?: string;
  progress?: number;
  message?: string;
  events?: unknown[];
  [key: string]: unknown;
}
export interface RequestMap {
  health: Record<string, never>;
  projects: Record<string, never>;
  create: { path: string; language?: string; name?: string };
  clone: { url: string; language?: string };
  project: { project_id: string };
  changes: { project_id: string; target?: ContentTarget };
  scan: { project_id: string; target?: ContentTarget };
  generate: {
    project_id: string;
    provider?: ProviderMode;
    force?: boolean;
    confirm_external?: boolean;
    target?: ContentTarget;
    /** Stable host task identity. Replaying it resumes unfinished work. */
    resume_run_id?: string;
    request_id?: string;
    intent?: KnowledgeIntent;
    expected_model_identity?: string;
    expected_plan_token?: string;
  };
  knowledge: { project_id: string; target?: ContentTarget };
  action: { project_id: string; task_id: string; action: 'pause' | 'resume' | 'cancel' | 'repair' | 'reanalyse'; expected_revision: number; request_id: string; confirm_external?: boolean; expected_model_identity?: string; expected_plan_token?: string };
  drafts: { project_id: string; task_id: string };
  run: { project_id: string; target?: ContentTarget };
  cancel: { project_id: string; pause?: boolean };
  page: { project_id: string; slug: string };
  edit: {
    project_id: string;
    slug: string;
    markdown: string;
    expected_revision: number;
    expected_storage_token?: string;
  };
  resolve: {
    project_id: string;
    slug: string;
    markdown: string;
    expected_revision: number;
    expected_storage_token?: string;
  };
  plan: { project_id: string; plan: Record<string, unknown>; expected_plan_storage_token?: string };
  watch: { project_id: string; enabled: boolean };
  source: {
    project_id: string;
    path: string;
    start_line?: number;
    end_line?: number;
  };
  export: { project_id: string; target?: ContentTarget };
  import: {
    project_id: string;
    files: Record<string, string>;
    target?: ContentTarget;
  };
}
export interface ResponseMap {
  health: {
    status: string;
    version: string;
    backend: string;
    provider: Record<string, unknown>;
    demo_path?: string;
    local_only: boolean;
  };
  projects: Project[];
  create: Project;
  clone: Project;
  project: Project;
  changes: Record<string, unknown>;
  scan: Record<string, unknown>;
  generate: { run_id: string; task_id?: string; status: string; target?: ContentTarget };
  knowledge: RepoWikiKnowledgeSnapshot;
  action: RepoWikiKnowledgeSnapshot;
  drafts: { taskId: string; items: Array<{ id: string; title: string; markdown: string; sources: SourceRef[] }> };
  run: Run;
  cancel: { run_id?: string; status: string };
  page: WikiPage;
  edit: WikiPage;
  resolve: WikiPage;
  plan: Project;
  watch: Project;
  source: {
    path: string;
    content: string;
    total_lines: number;
    start_line: number;
    end_line: number;
    hash?: string;
  };
  export: Record<string, string>;
  import: Record<string, unknown>;
}
export interface ProgressEvent {
  project_id: string;
  run: Run;
  time: string;
  version?: 1;
  sequence?: number;
  instance_id?: string;
  context_id?: string;
}
export interface RepoWikiClient {
  invoke<A extends Action>(
    action: A,
    input: RequestMap[A],
  ): Promise<ResponseMap[A]>;
  subscribe(handler: (event: ProgressEvent) => void): () => void;
}
export type ModelCompletionInput = {
  systemPrompt: string;
  user: string;
  maxTokens?: number;
};
export type ModelComplete = (
  input: ModelCompletionInput,
  signal: AbortSignal,
) => Promise<string>;
/** Private host-to-process scope. Never accepted as public action input. */
export interface ProcessScope {
  contextId: string;
  modelLeaseId?: string;
  modelCacheKey?: string;
}
export type WireMessage =
  | { v: 1; type: "ready"; pid: number }
  | {
      v: 1;
      type: "request";
      id: string;
      action: Action | "shutdown";
      input: unknown;
      scope?: ProcessScope;
    }
  | { v: 1; type: "response"; id: string; ok: true; result: unknown }
  | {
      v: 1;
      type: "response";
      id: string;
      ok: false;
      error: { message: string; status: number };
    }
  | { v: 1; type: "event"; event: ProgressEvent }
  | { v: 1; type: "cancelRequest"; id: string }
  | { v: 1; type: "cancelContext"; id: string; contextId: string }
  | { v: 1; type: "modelRequest"; id: string; input: ModelCompletionInput; scope?: ProcessScope }
  | { v: 1; type: "modelResponse"; id: string; ok: boolean; text?: string }
  | { v: 1; type: "modelCancel"; id: string };
export class ContractError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ContractError";
  }
}
const fields: Record<Action, string[]> = {
  health: [],
  projects: [],
  create: ["path", "language", "name"],
  clone: ["url", "language"],
  project: ["project_id"],
  changes: ["project_id", "target"],
  scan: ["project_id", "target"],
  generate: ["project_id", "provider", "force", "confirm_external", "target", "resume_run_id", "request_id", "intent", "expected_model_identity", "expected_plan_token"],
  knowledge: ["project_id", "target"],
  action: ["project_id", "task_id", "action", "expected_revision", "request_id", "confirm_external", "expected_model_identity", "expected_plan_token"],
  drafts: ["project_id", "task_id"],
  run: ["project_id", "target"],
  cancel: ["project_id", "pause"],
  page: ["project_id", "slug"],
  edit: ["project_id", "slug", "markdown", "expected_revision", "expected_storage_token"],
  resolve: ["project_id", "slug", "markdown", "expected_revision", "expected_storage_token"],
  plan: ["project_id", "plan", "expected_plan_storage_token"],
  watch: ["project_id", "enabled"],
  source: ["project_id", "path", "start_line", "end_line"],
  export: ["project_id", "target"],
  import: ["project_id", "files", "target"],
};
const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
function validProcessScope(value: unknown): boolean {
  if (!plain(value) || typeof value.contextId !== "string" || !value.contextId || value.contextId.length > 200) return false;
  if (Object.keys(value).some(key => !["contextId", "modelLeaseId", "modelCacheKey"].includes(key))) return false;
  return ["modelLeaseId", "modelCacheKey"].every(key => value[key] === undefined || (typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 2000));
}
export function validateRequest(
  action: unknown,
  input: unknown,
): asserts action is Action {
  if (
    typeof action !== "string" ||
    !ACTIONS.includes(action as Action) ||
    !plain(input)
  )
    throw new ContractError("Unknown command or invalid request");
  const a = action as Action;
  if (Object.keys(input).some((k) => !fields[a].includes(k)))
    throw new ContractError("Unexpected request property");
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    throw new ContractError("Request must be serializable");
  }
  if (bytes > 8 * 1024 * 1024)
    throw new ContractError("Request exceeds 8 MiB", 413);
  if (
    input.target !== undefined &&
    !["wiki", "cards"].includes(input.target as string)
  )
    throw new ContractError("Invalid content target");
  const string = (k: string, max: number, required = false) => {
    const x = input[k];
    if (x === undefined && !required) return;
    if (
      typeof x !== "string" ||
      x.length > max ||
      (!x.length && k !== "markdown")
    )
      throw new ContractError(`Invalid ${k}`);
  };
  if (fields[a].includes("project_id")) {
    string("project_id", 100, true);
    if (!/^[a-zA-Z0-9_-]+$/.test(input.project_id as string))
      throw new ContractError("Invalid project_id");
  }
  if (fields[a].includes("slug")) {
    string("slug", 500, true);
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(input.slug as string))
      throw new ContractError("Invalid page slug");
  }
  if (a === "create") {
    string("path", 4096, true);
    string("name", 200);
  }
  if (a === "clone") string("url", 2048, true);
  if (a === "create" || a === "clone") {
    string("language", 20);
    if (
      input.language !== undefined &&
      !/^[A-Za-z][A-Za-z0-9-]{0,19}$/.test(input.language as string)
    )
      throw new ContractError("Invalid language");
  }
  for (const k of ["force", "confirm_external", "enabled", "pause"])
    if (input[k] !== undefined && typeof input[k] !== "boolean")
      throw new ContractError(`Invalid ${k}`);
  if (a === "generate" && input.resume_run_id !== undefined) {
    string("resume_run_id", 200);
    if (!/^[a-zA-Z0-9_-]+$/.test(input.resume_run_id as string)) throw new ContractError("Invalid resume_run_id");
  }
  for (const key of ['request_id', 'expected_model_identity', 'expected_plan_token']) if (input[key] !== undefined) string(key, 1000);
  if (a === 'generate' && input.intent !== undefined && !['generate', 'update', 'regenerate', 'repair'].includes(String(input.intent))) throw new ContractError('Invalid knowledge intent');
  if (a === 'action' || a === 'drafts') {
    string('task_id', 200, true);
    if (a === 'action') {
      string('request_id', 200, true);
      if (!['pause', 'resume', 'cancel', 'repair', 'reanalyse'].includes(String(input.action)) || !Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 0) throw new ContractError('Invalid knowledge action');
    }
  }
  if (a === "watch" && typeof input.enabled !== "boolean")
    throw new ContractError("enabled is required");
  if (
    a === "generate" &&
    input.provider !== undefined &&
    !["demo", "real"].includes(input.provider as string)
  )
    throw new ContractError("Invalid provider");
  if (a === "edit" || a === "resolve") {
    string("markdown", 2_000_000, true);
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      (input.expected_revision as number) < 0
    )
      throw new ContractError("Invalid expected_revision");
  }
  if (a === "source") {
    string("path", 500, true);
    for (const k of ["start_line", "end_line"])
      if (
        input[k] !== undefined &&
        (!Number.isSafeInteger(input[k]) || (input[k] as number) < 1)
      )
        throw new ContractError("Invalid source range");
    const start = (input.start_line as number) ?? 1,
      end = input.end_line as number | undefined;
    if (end !== undefined && (end < start || end - start > 1999))
      throw new ContractError("Source range maximum is 2000 lines");
  }
  if (a === "plan" && !plain(input.plan))
    throw new ContractError("plan must be an object");
  for (const key of ["expected_storage_token", "expected_plan_storage_token"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !/^[a-f0-9]{64}$/.test(input[key] as string))) throw new ContractError(`Invalid ${key}`);
  if (
    a === "import" &&
    (!plain(input.files) ||
      Object.keys(input.files).length > 500 ||
      Object.values(input.files).some((v) => typeof v !== "string"))
  )
    throw new ContractError(
      "files must contain at most 500 Markdown text files",
    );
}
export function isWireMessage(value: unknown): value is WireMessage {
  if (!plain(value) || value.v !== 1 || typeof value.type !== "string")
    return false;
  if (value.type === "ready") return Number.isSafeInteger(value.pid);
  if (value.type === "event")
    return (
      plain(value.event) &&
      typeof value.event.project_id === "string" &&
      plain(value.event.run)
    );
  if (typeof value.id !== "string" || value.id.length > 100) return false;
  if (value.scope !== undefined && !validProcessScope(value.scope)) return false;
  if (value.type === "cancelContext") return typeof value.contextId === "string" && value.contextId.length <= 200;
  if (value.type === "request")
    return (
      value.action === "shutdown" || ACTIONS.includes(value.action as Action)
    );
  if (value.type === "cancelRequest" || value.type === "modelCancel")
    return true;
  if (value.type === "response")
    return (
      typeof value.ok === "boolean" &&
      (value.ok ||
        (plain(value.error) && typeof value.error.message === "string"))
    );
  if (value.type === "modelRequest")
    return (
      plain(value.input) &&
      typeof value.input.systemPrompt === "string" &&
      typeof value.input.user === "string" &&
      value.input.user.length <= 600_000 &&
      value.input.systemPrompt.length <= 20_000
    );
  return (
    value.type === "modelResponse" &&
    typeof value.ok === "boolean" &&
    (!value.ok ||
      (typeof value.text === "string" && value.text.length <= 2_000_000))
  );
}
/** Shared HTTP-demo route map. Embedded clients call the same typed actions directly. */
export function routeRequest(
  method: string,
  path: string,
  body: unknown = {},
): { action: Action; input: any } {
  const url = new URL(path, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let action: Action | undefined;
  let input: any = {};
  if (parts[0] === "health" && method === "GET") action = "health";
  else if (parts[0] === "clone" && method === "POST") {
    action = "clone";
    input = body;
  } else if (parts[0] === "projects" && parts.length === 1) {
    if (method === "GET") action = "projects";
    else if (method === "POST") {
      action = "create";
      input = body;
    }
  } else if (parts[0] === "projects" && parts[1]) {
    input = { project_id: parts[1] };
    const tail = parts[2];
    if (!tail && method === "GET") action = "project";
    else if (tail === "pages" && parts.length > 3) {
      action =
        method === "GET" ? "page" : method === "PUT" ? "edit" : undefined;
      input = {
        ...(method === "PUT" ? (body as any) : {}),
        ...input,
        slug: parts.slice(3).join("/"),
      };
    } else if (tail === "resolve" && parts.length > 3 && method === "POST") {
      action = "resolve";
      input = { ...(body as any), ...input, slug: parts.slice(3).join("/") };
    } else if (
      tail === "runs" &&
      parts[3] === "latest" &&
      parts.length === 4 &&
      method === "GET"
    )
      action = "run";
    else if (parts.length === 3) {
      const verbs: Record<string, string> = {
        changes: "GET",
        scan: "POST",
        generate: "POST",
        cancel: "POST",
        plan: "PUT",
        watch: "PUT",
        source: "GET",
        export: "GET",
        import: "POST",
      };
      if (verbs[tail] === method) {
        action = tail as Action;
        if (method !== "GET") input = { ...(body as any), ...input };
        if (tail === "source") {
          input.path = url.searchParams.get("path");
          for (const key of ["start_line", "end_line"])
            if (url.searchParams.has(key))
              input[key] = Number(url.searchParams.get(key));
        }
      }
    }
  }
  if (!action) throw new ContractError("Route not found", 404);
  if (
    method === "GET" &&
    ["changes", "run", "export"].includes(action) &&
    url.searchParams.has("target")
  )
    input.target = url.searchParams.get("target");
  validateRequest(action, input);
  return { action, input };
}
