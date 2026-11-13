/** JSON-only contract shared by renderer, main authority and agent host. */
export interface SessionWorkflowTarget {
  targetSessionPath: string;
  expectedSessionId: string;
  expectedLeafId: string | null;
  expectedRevision: string;
}
export interface SessionTreeNodeDto {
  id: string; parentId: string | null; type: string; role?: string;
  label?: string; preview: string; children: SessionTreeNodeDto[];
  current: boolean; onBranch: boolean; legacyExcluded: boolean;
  original?: unknown; effective?: unknown; replaced: boolean; inContext: boolean; inWindow?: boolean; omitted?: boolean;
}
export interface SessionTreeDto extends SessionWorkflowTarget {
  nodes: SessionTreeNodeDto[]; busy: boolean; needsReload: boolean; notice?: string;
}
export type SessionWorkflowAction = 'tree'|'reload'|'label'|'navigate-preview'|'navigate'|'cancel-summary'|'edit'|'restore-original'|'fork-preview'|'clone-preview'|'fork'|'clone'|'export-preview'|'export'|'import-preview'|'import';
export interface SessionWorkflowRequest extends Partial<SessionWorkflowTarget> {
  action: SessionWorkflowAction; entryId?: string; label?: string;
  text?: string; summarize?: boolean; draftChoice?: 'keep'|'replace';
  position?: 'before'|'at'; format?: 'html'|'jsonl'; ticket?: string;
  /** Only the main-process file-dialog authority may populate paths. */
  destination?: string; source?: string; overwrite?: boolean;
  cwd?: string; preferenceChoice?: 'file'|'current'; confirmedPreferences?: {model?:{provider:string;id:string};thinkingLevel?:string;fastMode?:boolean};
}
export interface SessionWorkflowAck {
  status: 'ok'|'cancelled'|'persisted-needs-reload'; tree?: SessionTreeDto;
  sessionId?: string; sessionPath?: string; editorText?: string;
  targetLeafId?: string|null; ticket?: string; destination?: string; exists?: boolean;
  format?: 'html'|'jsonl'; scope?: string; nodeCount?: number; cwd?: string;
  requestedPreferences?: unknown; sensitive?: string[]; preview?: unknown; notice?: string;
}
