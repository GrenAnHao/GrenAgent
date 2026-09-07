export type WikiLifecycle = 'active' | 'deleting' | 'deleted';
export type WikiRequestContext = { kind: 'admin' } | { kind: 'project'; workspace: string };
export interface WikiVersion { revision: number; contentHash: string }
export interface WikiSourceRef { sourceId: string; revision: number }
export interface WikiBucket { kbId: string; storageKey: string; legacyWorkspace?: string }
export interface WikiLibrary extends WikiBucket {
  name: string; description: string; bindings: string[]; revision: number;
  lifecycle: WikiLifecycle; epoch: number; createdAt: number; updatedAt: number;
}
export interface WikiLibraryView extends WikiLibrary {
  location: string; sourceCount: number; pageCount: number; pendingSourceCount: number;
  availability: 'draft' | 'pending' | 'available'; lastError?: string; activeJobId?: string;
  deletingTargets?: WikiTarget[];
}
export interface WikiLibraryInput { name: string; description: string; bindings: string[] }
export interface WikiSource extends WikiVersion {
  kbId: string; sourceId: string; name: string; kind: 'manual' | 'upload' | 'project' | 'legacy';
  projectWorkspace?: string; relativePath?: string; snapshotPath: string;
  lifecycle: WikiLifecycle; epoch: number; status: 'pending' | 'processing' | 'succeeded' | 'failed';
  processedHash?: string; generatedPageId: string; generationSuppressed: boolean;
  error?: string; createdAt: number; updatedAt: number;
}
export type WikiSourceInput =
  | { kind: 'manual' | 'upload'; name: string; content: string }
  | { kind: 'project'; projectWorkspace: string; relativePath: string; expectedContentHash: string };
export interface WikiImportPreview {
  projectWorkspace: string; relativePath: string; name: string; contentHash: string; bytes: number;
}
export interface WikiPage extends WikiVersion {
  kbId: string; pageId: string; title: string; content: string; path: string;
  sourceRefs: WikiSourceRef[]; locked: boolean; autoSourceId?: string;
  lifecycle: WikiLifecycle; epoch: number; updatedAt: number;
}
export interface WikiPageInput { title: string; content: string; sourceRefs: WikiSourceRef[] }
export interface WikiPageSave extends WikiPageInput { expected: WikiVersion }
export interface WikiPageHit { kbId: string; pageId: string; title: string; snippet: string }
export type WikiTarget = { kbId: string } & (
  | { kind: 'library' } | { kind: 'source'; sourceId: string } | { kind: 'page'; pageId: string });
export interface WikiWritePermit {
  kbId: string; libraryEpoch: number; sourceId: string; sourceEpoch: number;
  sourceRevision: number; pageId: string; pageEpoch: number; expected: WikiVersion | null;
}
export type WikiPublishResult =
  | { state: 'published'; page: WikiPage }
  | { state: 'skipped'; reason: 'locked' | 'changed' | 'multi_source' | 'deleted' | 'suppressed' };
export interface WikiTaskTarget {
  taskSource: 'agent_job' | 'service_task'; taskId: string; kbId: string;
  sourceId?: string; pageId?: string; active: boolean; canCancel: boolean;
}
export interface WikiIngestSummary { succeeded: number; skipped: number; failed: number }
export interface WikiIngestItem { sourceId: string; sourceRevision: number; contentHash: string; permit: WikiWritePermit }
export interface WikiIngestRun { jobId: string; kbId: string; items: WikiIngestItem[]; cancelRequested: boolean; summary: WikiIngestSummary; model: string }
export interface WikiIngestReceipt { jobId: string; targetCount: number; model: string }
export interface WikiIngestPreview { sourceIds: string[]; targetCount: number; model: string }
export interface WikiDeletePreview { target: WikiTarget; name: string; revision: number; sources: number; pages: number; bindings: string[] }
export type WikiDeleteResult = { state: 'deleted' } | { state: 'waiting'; tasks: WikiTaskTarget[] };
export interface WikiDiagnostic { code: string; path: string; message: string; kbId?: string }
export interface WikiReindexResult { pages: number; diagnostics: WikiDiagnostic[] }

export interface WikiManagementApi {
  libraries: {
    list(input?: { query?: string; project?: string }): Promise<WikiLibraryView[]>;
    read(kbId: string): Promise<WikiLibraryView>;
    create(input: WikiLibraryInput): Promise<WikiLibraryView>;
    update(kbId: string, input: WikiLibraryInput, expectedRevision: number): Promise<WikiLibraryView>;
    previewDelete(kbId: string): Promise<WikiDeletePreview>;
    remove(kbId: string, cancelActive: boolean): Promise<WikiDeleteResult>;
    previewIngest(kbId: string, sourceIds?: string[], regenerateSourceIds?: string[]): Promise<WikiIngestPreview>;
    ingest(kbId: string, sourceIds?: string[], regenerateSourceIds?: string[], expectedModel?: string): Promise<WikiIngestReceipt>;
    reindex(kbId: string): Promise<WikiReindexResult>;
  };
  sources: {
    list(kbId: string): Promise<WikiSource[]>;
    read(kbId: string, sourceId: string, revision?: number): Promise<{ source: WikiSource; content: string; version?: WikiVersion }>;
    previewImport(kbId: string, projectWorkspace: string, relativePath: string): Promise<WikiImportPreview>;
    create(kbId: string, input: WikiSourceInput): Promise<WikiSource>;
    update(kbId: string, sourceId: string, content: string, expected: WikiVersion): Promise<WikiSource>;
    previewDelete(kbId: string, sourceId: string): Promise<WikiDeletePreview>;
    remove(kbId: string, sourceId: string, cancelActive: boolean): Promise<WikiDeleteResult>;
  };
  pages: {
    list(kbId: string): Promise<Array<Omit<WikiPage,'content'>>>;
    read(kbId: string, pageId: string): Promise<WikiPage | undefined>;
    create(kbId: string, input: WikiPageInput): Promise<WikiPage>;
    update(kbId: string, pageId: string, input: WikiPageSave): Promise<WikiPage>;
    setLocked(kbId: string, pageId: string, locked: boolean, expected: WikiVersion): Promise<WikiPage>;
    previewDelete(kbId: string, pageId: string): Promise<WikiDeletePreview>;
    remove(kbId: string, pageId: string, cancelActive: boolean): Promise<WikiDeleteResult>;
  };
}
