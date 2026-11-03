/** Renderer-safe, versioned native Wiki RPC; no Node/Electron imports. */
export type NativeIntent = 'full' | 'update' | 'sync' | 'regenerate' | 'repair' | 'resume';
export interface NativeAuthorPage { id: string; title: string; prompt: string; template?: string; children?: NativeAuthorPage[] }
export interface NativeAuthor { schema_version: 1; engine: 'qoder-wiki-local-v1'; branch: string; locale: string; revision: number; storage_token?: string; mode: 'auto' | 'pages'; constraints: string[]; notes: Array<{ Text: string; Author?: string }>; pages: NativeAuthorPage[] }
export interface NativeOperation { id: string; task_id?: string; revision: number; state: string; stage?: string; error?: string; executor_active?: boolean; recoverable?: boolean }
export interface NativePublication { id: string; published_count: number; readable_count?: number; failed_count: number; partial: boolean; failed_items: string[] }
export interface NativeProjection { publication_id: string; status: 'pending' | 'ready' | 'conflict' | 'error'; error?: string }
export interface NativeSnapshot { engine: 'qoder-wiki-local-v1'; executionEnabled: boolean; operation: NativeOperation | null; publication: NativePublication | null; projection: NativeProjection | null; accounting?: { activeSessions: number; waiting: number; inFlight: number; submitted: number; dispatched: number; settled: number; toolsStarted: number; toolsFinished: number; unknown: number } }
export interface NativeSpendingPolicy { max_model_requests?: number; max_total_tokens?: number }
export interface NativeConfirmation { confirmation_id: string; intent: NativeIntent; model_identity: string; author_revision: number; scope: unknown; branch: string; target_commit: string; task_revision: number | null; operation_id?: string; spending_policy?: NativeSpendingPolicy; effective_profile?: { context_window: number; max_output_tokens: number; work_steps: number; closing_turns: number } }
export type NativeRequest = { project_id: string } & (
  | { command: 'status'; operation_id?: string }
  | { command: 'author.read' }
  | { command: 'author.save'; author: NativeAuthor; expected_revision: number; expected_storage_token: string }
  | { command: 'author.convert'; expected_revision: number; expected_storage_token: string }
  | { command: 'prepare'; intent: NativeIntent; operation_id?: string; spending_policy?: NativeSpendingPolicy }
  | { command: 'start'; confirmation_id: string; request_id: string; confirm_external: true }
  | { command: 'control'; operation_id: string; expected_revision: number; action: 'pause' | 'cancel' }
  | { command: 'drafts'; operation_id: string }
  | { command: 'projection.repair'; publication_id: string }
);
export type NativeResponse =
  | { command: 'status'; value: NativeSnapshot }
  | { command: 'author.read' | 'author.save'; value: NativeAuthor }
  | { command: 'author.convert'; value: { author: NativeAuthor; dropped_depends_on: string[] } }
  | { command: 'prepare'; value: NativeConfirmation }
  | { command: 'start' | 'control'; value: NativeOperation }
  | { command: 'drafts'; value: { items: Array<{ id: string; title: string; markdown: string }> } }
  | { command: 'projection.repair'; value: NativeProjection };
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const text = (v: unknown, max = 1000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function validateNativeRequest(value: unknown): asserts value is NativeRequest {
  if (!plain(value) || !text(value.project_id, 100) || !/^[a-zA-Z0-9_-]+$/.test(value.project_id as string) || typeof value.command !== 'string') throw new Error('Invalid native request');
  const allowed: Record<string, string[]> = { status: ['operation_id'], 'author.read': [], 'author.save': ['author','expected_revision','expected_storage_token'], 'author.convert': ['expected_revision','expected_storage_token'], prepare: ['intent','operation_id'], start: ['confirmation_id','request_id','confirm_external'], control: ['operation_id','expected_revision','action'], drafts: ['operation_id'], 'projection.repair': ['publication_id'] };
  if (value.command === 'prepare') allowed.prepare.push('spending_policy');
  const fields = allowed[value.command]; if (!fields || Object.keys(value).some(key => key !== 'project_id' && key !== 'command' && !fields.includes(key))) throw new Error('Invalid native command or property');
  if (value.spending_policy !== undefined && (!plain(value.spending_policy) || Object.entries(value.spending_policy).some(([key, n]) => !['max_model_requests', 'max_total_tokens'].includes(key) || !Number.isSafeInteger(n) || Number(n) < 0))) throw new Error('Invalid spending policy');
  for (const key of ['operation_id','confirmation_id','request_id','publication_id']) if (value[key] !== undefined && !text(value[key], 200)) throw new Error(`Invalid ${key}`);
  if (['control','drafts'].includes(value.command) && !text(value.operation_id, 200)) throw new Error('Invalid operation_id');
  if (value.command === 'projection.repair' && !text(value.publication_id, 200)) throw new Error('Invalid publication_id');
  if (['author.save','author.convert','control'].includes(value.command) && !revision(value.expected_revision)) throw new Error('Invalid expected_revision');
  if (['author.save','author.convert'].includes(value.command) && (typeof value.expected_storage_token !== 'string' || value.expected_storage_token.length > 200)) throw new Error('Invalid expected_storage_token');
  if (value.command === 'prepare' && (!['full','update','sync','regenerate','repair','resume'].includes(String(value.intent)) || (['repair','resume'].includes(String(value.intent)) && !text(value.operation_id, 200)))) throw new Error('Invalid native intent');
  if (value.command === 'prepare' && value.operation_id !== undefined && !['repair','resume'].includes(String(value.intent))) throw new Error('Unexpected operation_id for new native task');
  if (value.command === 'start' && (!text(value.confirmation_id, 200) || !text(value.request_id, 200) || value.confirm_external !== true)) throw new Error('Invalid native confirmation');
  if (value.command === 'control' && !['pause','cancel'].includes(String(value.action))) throw new Error('Invalid control action');
  if (value.command === 'author.save') {
    const a = value.author; if (!plain(a) || a.schema_version !== 1 || a.engine !== 'qoder-wiki-local-v1' || !text(a.branch, 500) || !text(a.locale, 20) || !revision(a.revision) || (a.storage_token !== undefined && (typeof a.storage_token !== 'string' || a.storage_token.length > 200)) || !['auto','pages'].includes(String(a.mode)) || !Array.isArray(a.constraints) || a.constraints.some(x => typeof x !== 'string') || !Array.isArray(a.notes) || !Array.isArray(a.pages)) throw new Error('Invalid author config');
    if (Object.keys(a).some(k => !['schema_version','engine','branch','locale','revision','storage_token','mode','constraints','notes','pages'].includes(k))) throw new Error('Invalid author property');
    if (a.notes.some(n => !plain(n) || typeof n.Text !== 'string' || (n.Author !== undefined && typeof n.Author !== 'string') || Object.keys(n).some(k => !['Text','Author'].includes(k)))) throw new Error('Invalid author note');
    const ids = new Set<string>();
    const pages = (items: unknown[], depth: number): boolean => depth <= 20 && items.every(p => { if (!plain(p) || !text(p.id,200) || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(p.id as string) || ids.has(p.id as string) || !text(p.title,500) || !text(p.prompt,100000) || (p.template !== undefined && typeof p.template !== 'string') || Object.keys(p).some(k => !['id','title','prompt','template','children'].includes(k)) || (p.children !== undefined && !Array.isArray(p.children))) return false; ids.add(p.id as string); return p.children === undefined || pages(p.children as unknown[], depth + 1); });
    if (!pages(a.pages, 0) || (a.mode === 'pages' && a.pages.length === 0) || (a.mode === 'auto' && a.pages.length > 0)) throw new Error('Invalid author pages');
  }
}
