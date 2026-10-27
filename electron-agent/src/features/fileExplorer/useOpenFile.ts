import { useCallback, useEffect, useRef, useState } from 'react';
import { files, type FilesChangedEvent } from '../../lib/files';
import { pathsEquivalent } from '../../lib/pathUtils';
import { baseName, detectLineSeparator, fileKindOf, parentDir, type LineSeparator } from './fileKinds';
import type { UnsavedChoice } from './unsavedChanges';

export type ViewMode = 'preview' | 'edit';

export interface TextFile {
  status: 'text';
  path: string;
  kind: 'markdown' | 'text';
  size: number;
  truncated: boolean;
  /** 磁盘上（最近一次读到或保存）的内容。 */
  original: string;
  content: string;
  /** 换文件、放弃修改、从磁盘重新载入时变；编辑器据此整份替换文档，其余时候它自己持有文档。 */
  docVersion: number;
  lineSeparator: LineSeparator;
  mode: ViewMode;
  /** 编辑器里已经有按键，正文还没送上来。脏标记靠它先亮。 */
  pendingEdit?: boolean;
  /** 磁盘上的文件被别人改了 / 删了，而这边有未保存的修改。 */
  disk: 'same' | 'changed' | 'deleted';
  saving: boolean;
  saveError: string | null;
}

export type OpenFileState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'error'; path: string; message: string }
  | { status: 'image'; path: string; size: number; url: string }
  | { status: 'binary'; path: string; size: number }
  | TextFile;

export interface OpenFileApi {
  file: OpenFileState;
  dirty: boolean;
  /** true：现在打开的就是 path（含本来就在看它）；false：被「未保存」询问取消，或被后来的 open 顶掉。 */
  open: (path: string) => Promise<boolean>;
  setContent: (content: string) => void;
  /** 编辑器有按键、正文还没送上来时立刻把脏标记亮上。 */
  noteEdit: () => void;
  /** 保存和磁盘比对前，从编辑器读最新正文。传 null 表示编辑器卸了。 */
  bindEditorText: (pull: (() => string) | null) => void;
  setMode: (mode: ViewMode) => void;
  toggleMode: () => void;
  save: () => Promise<boolean>;
  reloadFromDisk: () => Promise<void>;
  /** 磁盘变更提示里选「保留我的修改」：同一份磁盘内容不再提示，之后保存会覆盖它。 */
  keepLocal: () => void;
  onFilesChanged: (event: Pick<FilesChangedEvent, 'dirs' | 'paths'>) => void;
  /** 有未保存修改时问用户；可以继续（保存成功或放弃）返回 true。 */
  resolveUnsaved: () => Promise<boolean>;
  isDirty: () => boolean;
}

type Confirm = (fileName: string) => Promise<UnsavedChoice>;

function isDirtyState(file: OpenFileState): boolean {
  return file.status === 'text' && (file.pendingEdit === true || file.content !== file.original);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

let docVersionSeq = 0;

export function useOpenFile(workspace: string, confirm: Confirm): OpenFileApi {
  const [file, setFile] = useState<OpenFileState>({ status: 'idle' });
  const fileRef = useRef<OpenFileState>(file);
  const tokenRef = useRef(0);
  /** 用户选过「保留我的修改」时那份磁盘内容。 */
  const dismissedDiskRef = useRef<string | null>(null);
  /** 最近一次检测到、和本地不同的磁盘内容。 */
  const pendingDiskRef = useRef<string | null>(null);
  /** 编辑器当前正文。按键先亮脏标记，整篇字符串稍后才送上来；保存前从这里取。 */
  const editorTextRef = useRef<(() => string) | null>(null);
  const pullEditor = useCallback((current: OpenFileState): OpenFileState => {
    const latest = editorTextRef.current?.();
    if (current.status !== 'text' || typeof latest !== 'string') return current;
    if (current.content === latest && !current.pendingEdit) return current;
    return { ...current, content: latest, pendingEdit: false };
  }, []);

  /** 同步更新 ref 和 state：异步回调里读到的总是最新状态。换掉图片时顺手回收 blob URL。 */
  const update = useCallback((fn: (cur: OpenFileState) => OpenFileState) => {
    const prev = fileRef.current;
    const next = fn(prev);
    if (next === prev) return;
    if (prev.status === 'image' && (next.status !== 'image' || next.url !== prev.url)) URL.revokeObjectURL(prev.url);
    fileRef.current = next;
    setFile(next);
  }, []);

  useEffect(
    () => () => {
      const cur = fileRef.current;
      if (cur.status === 'image') URL.revokeObjectURL(cur.url);
    },
    [],
  );

  const loadPath = useCallback(
    async (path: string): Promise<OpenFileState> => {
      const kind = fileKindOf(path);
      if (kind === 'image') {
        const bin = await files.readBinary(workspace, path);
        return { status: 'image', path, size: bin.size, url: URL.createObjectURL(base64ToBlob(bin.data, bin.mime_type)) };
      }
      const view = await files.readView(workspace, path);
      if (view.kind === 'binary') return { status: 'binary', path, size: view.size };
      return {
        status: 'text',
        path,
        kind,
        size: view.size,
        truncated: view.truncated,
        original: view.content,
        content: view.content,
        docVersion: ++docVersionSeq,
        lineSeparator: detectLineSeparator(view.content),
        mode: 'preview',
        disk: 'same',
        saving: false,
        saveError: null,
      };
    },
    [workspace],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const pulled = pullEditor(fileRef.current);
    if (pulled !== fileRef.current) fileRef.current = pulled;
    const cur = fileRef.current;
    if (cur.status !== 'text' || cur.truncated || cur.saving) return false;
    const { path, content } = cur;
    update((f) =>
      f.status === 'text' && f.path === path ? { ...f, content, pendingEdit: false, saving: true, saveError: null } : f,
    );
    try {
      await files.write(workspace, path, content);
      dismissedDiskRef.current = null;
      pendingDiskRef.current = null;
      update((f) =>
        f.status === 'text' && f.path === path ? { ...f, original: content, saving: false, disk: 'same' } : f,
      );
      return true;
    } catch (err) {
      update((f) => (f.status === 'text' && f.path === path ? { ...f, saving: false, saveError: errorText(err) } : f));
      return false;
    }
  }, [workspace, update, pullEditor]);

  const resolveUnsaved = useCallback(async (): Promise<boolean> => {
    const cur = fileRef.current;
    if (!isDirtyState(cur) || cur.status !== 'text') return true;
    const choice = await confirm(baseName(cur.path));
    if (choice === 'cancel') return false;
    if (choice === 'save') return save();
    update((f) => (f.status === 'text' ? { ...f, content: f.original, pendingEdit: false, docVersion: ++docVersionSeq } : f));
    return true;
  }, [confirm, save, update]);

  const open = useCallback(
    async (path: string): Promise<boolean> => {
      const cur = fileRef.current;
      if ('path' in cur && cur.path === path && cur.status !== 'error') return true;
      if (!(await resolveUnsaved())) return false;
      const token = ++tokenRef.current;
      dismissedDiskRef.current = null;
      pendingDiskRef.current = null;
      update(() => ({ status: 'loading', path }));
      try {
        const next = await loadPath(path);
        if (token !== tokenRef.current) {
          if (next.status === 'image') URL.revokeObjectURL(next.url);
          return false;
        }
        update(() => next);
      } catch (err) {
        if (token !== tokenRef.current) return false;
        update(() => ({ status: 'error', path, message: errorText(err) }));
      }
      return true;
    },
    [loadPath, resolveUnsaved, update],
  );

  const setContent = useCallback(
    (content: string) =>
      update((f) => (f.status === 'text' && (f.content !== content || f.pendingEdit) ? { ...f, content, pendingEdit: false } : f)),
    [update],
  );

  const noteEdit = useCallback(() => {
    update((f) => (f.status === 'text' && !f.truncated && !isDirtyState(f) ? { ...f, pendingEdit: true } : f));
  }, [update]);

  const bindEditorText = useCallback((pull: (() => string) | null) => {
    editorTextRef.current = pull;
  }, []);

  const setMode = useCallback(
    (mode: ViewMode) =>
      update((f) => (f.status === 'text' && f.mode !== mode && !(mode === 'edit' && f.truncated) ? { ...f, mode } : f)),
    [update],
  );

  const toggleMode = useCallback(() => {
    const cur = fileRef.current;
    if (cur.status === 'text') setMode(cur.mode === 'edit' ? 'preview' : 'edit');
  }, [setMode]);

  const reloadFromDisk = useCallback(async () => {
    const cur = fileRef.current;
    if (cur.status !== 'text') return;
    const view = await files.readView(workspace, cur.path);
    if (view.kind !== 'text') return;
    dismissedDiskRef.current = null;
    pendingDiskRef.current = null;
    update((f) =>
      f.status === 'text' && f.path === cur.path
        ? {
            ...f,
            original: view.content,
            content: view.content,
            size: view.size,
            truncated: view.truncated,
            lineSeparator: detectLineSeparator(view.content),
            docVersion: ++docVersionSeq,
            disk: 'same',
            pendingEdit: false,
            mode: view.truncated ? 'preview' : f.mode,
          }
        : f,
    );
  }, [workspace, update]);

  const keepLocal = useCallback(() => {
    dismissedDiskRef.current = pendingDiskRef.current;
    update((f) => (f.status === 'text' && f.disk !== 'same' ? { ...f, disk: 'same' } : f));
  }, [update]);

  const checkText = useCallback(
    async (path: string) => {
      let view;
      try {
        view = await files.readView(workspace, path);
      } catch (err) {
        if (!/does not exist/i.test(errorText(err))) return;
        update((f) => (f.status === 'text' && f.path === path ? { ...f, disk: 'deleted' } : f));
        return;
      }
      if (view.kind !== 'text') return;
      const disk = view;
      // 读盘期间用户可能还在打字：按路径认文件，脏不脏以此刻的状态为准。
      update((f) => {
        if (f.status !== 'text' || f.path !== path) return f;
        const base = pullEditor(f);
        if (disk.content === base.original) {
          if (base === f && base.disk === 'same') return f;
          return base.disk === 'same' ? base : { ...base, disk: 'same' };
        }
        if (disk.content === dismissedDiskRef.current) return base === f ? f : base;
        if (isDirtyState(base)) {
          pendingDiskRef.current = disk.content;
          return base.disk === 'changed' ? base : { ...base, disk: 'changed' };
        }
        return {
          ...base,
          original: disk.content,
          content: disk.content,
          size: disk.size,
          truncated: disk.truncated,
          lineSeparator: detectLineSeparator(disk.content),
          docVersion: ++docVersionSeq,
          disk: 'same',
          pendingEdit: false,
          mode: disk.truncated ? 'preview' : base.mode,
        };
      });
    },
    [workspace, update, pullEditor],
  );

  const onFilesChanged = useCallback(
    (event: Pick<FilesChangedEvent, 'dirs' | 'paths'>) => {
      const cur = fileRef.current;
      if (cur.status === 'idle' || cur.status === 'loading') return;
      const named = event.paths.some((p) => pathsEquivalent(p, cur.path));
      // 点名了具体文件就只核对那些文件。paths 为空才按父目录回退（监听只报了目录、没点名是哪个文件）。
      const inParent = event.paths.length === 0 && event.dirs.some((d) => pathsEquivalent(d, parentDir(cur.path)));
      if (cur.status === 'text') {
        if (named || inParent) void checkText(cur.path);
        return;
      }
      if (!named) return;
      const token = tokenRef.current;
      loadPath(cur.path)
        .then((next) => {
          if (token !== tokenRef.current || fileRef.current.status === 'text') {
            if (next.status === 'image') URL.revokeObjectURL(next.url);
            return;
          }
          update(() => next);
        })
        .catch(() => {});
    },
    [checkText, loadPath, update],
  );

  const isDirty = useCallback(() => isDirtyState(fileRef.current), []);

  return {
    file,
    dirty: isDirtyState(file),
    open,
    setContent,
    noteEdit,
    bindEditorText,
    setMode,
    toggleMode,
    save,
    reloadFromDisk,
    keepLocal,
    onFilesChanged,
    resolveUnsaved,
    isDirty,
  };
}
